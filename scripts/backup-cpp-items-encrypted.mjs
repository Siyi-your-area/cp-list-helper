#!/usr/bin/env node

import {
  constants as fsConstants,
  createReadStream,
  existsSync,
} from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "AES-256-GCM";
const CIPHER_NAME = "aes-256-gcm";
const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_ATTEMPTS = 3;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const REQUIRED_SCHEMA_TABLES = [
  "cpp_items",
  "event_access",
  "events",
  "wish_items",
];
const RECOVERY_DDL_FILES = [
  "docs/init-db.sql",
  "docs/migrations/001_add_share_code.sql",
  "docs/migrations/002_add_hot_count_and_description.sql",
  "docs/migrations/003_add_event_access.sql",
];
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function fail(message) {
  throw new Error(message);
}

function normalizeBase64(value, label, expectedBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail(`${label} must be standard base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== expectedBytes ||
    decoded.toString("base64") !== value
  ) {
    fail(`${label} must encode exactly ${expectedBytes} bytes`);
  }
  return decoded;
}

function loadKey() {
  return normalizeBase64(
    process.env.BACKUP_AES_KEY_BASE64,
    "BACKUP_AES_KEY_BASE64",
    32
  );
}

function loadExpectedProjectRef() {
  const projectRef = process.env.EXPECTED_SUPABASE_PROJECT_REF;
  if (typeof projectRef !== "string" || !/^[a-z0-9]+$/.test(projectRef)) {
    fail("EXPECTED_SUPABASE_PROJECT_REF is required and invalid");
  }
  return projectRef;
}

function parseInteger(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`${label} is not a safe non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    return BigInt(value);
  }
  fail(`${label} is not a non-negative integer`);
}

function createMetrics() {
  return {
    rowCount: 0,
    distinctDoujinshi: new Set(),
    minId: null,
    maxId: null,
    previousId: null,
    rowColumns: null,
  };
}

function observeRow(metrics, row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail("backup row must be a JSON object");
  }
  const id = parseInteger(row.id, "cpp_items.id");
  const rowColumns = Object.keys(row).sort();
  if (metrics.rowColumns === null) {
    metrics.rowColumns = rowColumns;
  } else if (
    metrics.rowColumns.length !== rowColumns.length ||
    metrics.rowColumns.some((column, index) => column !== rowColumns[index])
  ) {
    fail("cpp_items rows have inconsistent column sets");
  }
  if (metrics.previousId !== null && id <= metrics.previousId) {
    fail("cpp_items pagination returned a duplicate or out-of-order id");
  }
  if (row.doujinshi_id === null || row.doujinshi_id === undefined) {
    fail("cpp_items.doujinshi_id is missing");
  }
  const doujinshiId = parseInteger(
    row.doujinshi_id,
    "cpp_items.doujinshi_id"
  ).toString();

  metrics.rowCount += 1;
  metrics.distinctDoujinshi.add(doujinshiId);
  metrics.minId ??= id;
  metrics.maxId = id;
  metrics.previousId = id;
}

function summarizeMetrics(metrics) {
  return {
    rowCount: metrics.rowCount,
    distinctDoujinshi: metrics.distinctDoujinshi.size,
    minId: metrics.minId === null ? null : metrics.minId.toString(),
    maxId: metrics.maxId === null ? null : metrics.maxId.toString(),
    rowColumns: metrics.rowColumns ?? [],
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function schemaSha256(postgrestSchemas) {
  return createHash("sha256").update(stableJson(postgrestSchemas)).digest("hex");
}

function sha256Text(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function manifestHmacSha256(manifest, key) {
  const authenticated = { ...manifest };
  delete authenticated.manifestHmac;
  return createHmac("sha256", key)
    .update(stableJson(authenticated))
    .digest("hex");
}

function addManifestHmac(manifest, key) {
  return {
    ...manifest,
    manifestHmac: manifestHmacSha256(manifest, key),
  };
}

function equalStringArrays(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function schemaColumns(postgrestSchemas) {
  const properties = postgrestSchemas?.cpp_items?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    fail("public.cpp_items OpenAPI schema has no properties");
  }
  const columns = Object.keys(properties).sort();
  if (
    columns.length === 0 ||
    !columns.includes("id") ||
    !columns.includes("doujinshi_id")
  ) {
    fail("public.cpp_items OpenAPI properties are incomplete");
  }
  return columns;
}

async function loadRecoveryDdl() {
  const entries = [];
  for (const [index, relativePath] of RECOVERY_DDL_FILES.entries()) {
    const content = await readFile(
      path.join(REPOSITORY_ROOT, ...relativePath.split("/")),
      "utf8"
    );
    entries.push({
      order: index + 1,
      path: relativePath,
      sha256: sha256Text(content),
      content,
    });
  }
  return {
    recoveryDdl: entries,
    recoveryDdlSha256: sha256Text(stableJson(entries)),
  };
}

function validateRecoveryDdl(manifest) {
  if (
    !Array.isArray(manifest.recoveryDdl) ||
    manifest.recoveryDdl.length !== RECOVERY_DDL_FILES.length ||
    !/^[a-f0-9]{64}$/.test(manifest.recoveryDdlSha256)
  ) {
    fail("manifest recovery DDL structure is invalid");
  }
  for (const [index, entry] of manifest.recoveryDdl.entries()) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      entry.order !== index + 1 ||
      entry.path !== RECOVERY_DDL_FILES[index] ||
      typeof entry.content !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      sha256Text(entry.content) !== entry.sha256
    ) {
      fail(`manifest recovery DDL entry ${index + 1} is invalid`);
    }
  }
  if (
    sha256Text(stableJson(manifest.recoveryDdl)) !==
    manifest.recoveryDdlSha256
  ) {
    fail("manifest recoveryDdlSha256 does not match recoveryDdl");
  }
}

function extractPostgrestSchemas(openApiDocument) {
  if (
    !openApiDocument ||
    typeof openApiDocument !== "object" ||
    Array.isArray(openApiDocument)
  ) {
    fail("Supabase OpenAPI document is invalid");
  }
  const definitions =
    openApiDocument.definitions ?? openApiDocument.components?.schemas;
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) {
    fail("Supabase OpenAPI document has no schema definitions");
  }

  const schemas = {};
  for (const table of REQUIRED_SCHEMA_TABLES) {
    const definition = definitions[table];
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      fail(`Supabase OpenAPI is missing public.${table}`);
    }
    schemas[table] = stableValue(definition);
  }
  return stableValue(schemas);
}

async function writeAll(fileHandle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fileHandle.write(
      buffer,
      offset,
      buffer.length - offset
    );
    if (bytesWritten <= 0) fail("encrypted backup write made no progress");
    offset += bytesWritten;
  }
}

async function encryptRows(rows, outputPath, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER_NAME, key, iv);
  const plaintextHash = createHash("sha256");
  const ciphertextHash = createHash("sha256");
  const metrics = createMetrics();
  const fileHandle = await open(outputPath, "wx", 0o600);

  try {
    for await (const row of rows) {
      observeRow(metrics, row);
      const plaintext = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
      plaintextHash.update(plaintext);
      const encrypted = cipher.update(plaintext);
      ciphertextHash.update(encrypted);
      await writeAll(fileHandle, encrypted);
    }

    const finalChunk = cipher.final();
    ciphertextHash.update(finalChunk);
    await writeAll(fileHandle, finalChunk);
    await fileHandle.sync();

    return {
      ...summarizeMetrics(metrics),
      plaintextSha256: plaintextHash.digest("hex"),
      ciphertextSha256: ciphertextHash.digest("hex"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    await fileHandle.close();
  }
}

function manifestMetrics(manifest, key, expectedProjectRef) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("manifest must be a JSON object");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.manifestHmac)) {
    fail("manifest HMAC is invalid");
  }
  const expectedHmac = Buffer.from(manifestHmacSha256(manifest, key), "hex");
  const actualHmac = Buffer.from(manifest.manifestHmac, "hex");
  if (!timingSafeEqual(actualHmac, expectedHmac)) {
    fail("manifest HMAC authentication failed");
  }
  if (manifest.algorithm !== ALGORITHM) {
    fail(`unsupported manifest algorithm: ${String(manifest.algorithm)}`);
  }
  if (
    !Number.isSafeInteger(manifest.rowCount) ||
    manifest.rowCount < 0 ||
    !Number.isSafeInteger(manifest.distinctDoujinshi) ||
    manifest.distinctDoujinshi < 0
  ) {
    fail("manifest row counts are invalid");
  }
  if (
    !/^[a-f0-9]{64}$/.test(manifest.plaintextSha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.ciphertextSha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.schemaSha256)
  ) {
    fail("manifest SHA-256 values are invalid");
  }
  if (
    typeof manifest.sourceProjectRef !== "string" ||
    manifest.sourceProjectRef !== expectedProjectRef
  ) {
    fail("manifest sourceProjectRef does not match the expected project");
  }
  if (
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  ) {
    fail("manifest createdAt is invalid");
  }
  if (
    !Array.isArray(manifest.rowColumns) ||
    manifest.rowColumns.some(
      (column) => typeof column !== "string" || column.length === 0
    ) ||
    manifest.rowColumns.some(
      (column, index) => index > 0 && column <= manifest.rowColumns[index - 1]
    )
  ) {
    fail("manifest rowColumns must be sorted unique column names");
  }
  const expectedSchemas = extractPostgrestSchemas({
    definitions: manifest.postgrestSchemas,
  });
  if (schemaSha256(expectedSchemas) !== manifest.schemaSha256) {
    fail("manifest schemaSha256 does not match postgrestSchemas");
  }
  const expectedRowColumns = schemaColumns(expectedSchemas);
  if (!equalStringArrays(manifest.rowColumns, expectedRowColumns)) {
    fail("manifest rowColumns do not match public.cpp_items schema properties");
  }
  validateRecoveryDdl(manifest);

  const empty = manifest.rowCount === 0;
  if (empty) {
    if (
      manifest.distinctDoujinshi !== 0 ||
      manifest.minId !== null ||
      manifest.maxId !== null
    ) {
      fail("empty manifest metrics are inconsistent");
    }
  } else {
    const minId = parseInteger(manifest.minId, "manifest minId");
    const maxId = parseInteger(manifest.maxId, "manifest maxId");
    if (
      minId > maxId ||
      manifest.distinctDoujinshi > manifest.rowCount ||
      manifest.rowColumns.length === 0
    ) {
      fail("manifest metrics are inconsistent");
    }
  }

  return {
    iv: normalizeBase64(manifest.iv, "manifest iv", 12),
    authTag: normalizeBase64(manifest.authTag, "manifest authTag", 16),
  };
}

async function readManifest(manifestPath, key, expectedProjectRef) {
  const info = await stat(manifestPath);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
    fail("manifest is not a valid small regular file");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("manifest is not valid JSON");
  }
  manifestMetrics(manifest, key, expectedProjectRef);
  return manifest;
}

async function verifyEncryptedFile(outputPath, manifest, key, expectedProjectRef) {
  const { iv, authTag } = manifestMetrics(manifest, key, expectedProjectRef);
  const decipher = createDecipheriv(CIPHER_NAME, key, iv);
  decipher.setAuthTag(authTag);

  const plaintextHash = createHash("sha256");
  const ciphertextHash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const metrics = createMetrics();
  let buffered = "";

  function consumePlaintext(chunk, final = false) {
    plaintextHash.update(chunk);
    buffered += decoder.decode(chunk, { stream: !final });
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) fail("encrypted backup contains a blank NDJSON row");
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        fail("encrypted backup contains invalid NDJSON");
      }
      observeRow(metrics, row);
    }
  }

  try {
    for await (const encryptedChunk of createReadStream(outputPath)) {
      ciphertextHash.update(encryptedChunk);
      consumePlaintext(decipher.update(encryptedChunk));
    }
    consumePlaintext(decipher.final(), true);
  } catch (error) {
    if (
      error instanceof Error &&
      /(?:manifest|backup|NDJSON|cpp_items)/.test(error.message)
    ) {
      throw error;
    }
    fail("encrypted backup authentication or decoding failed");
  }

  if (buffered.length > 0) {
    let row;
    try {
      row = JSON.parse(buffered);
    } catch {
      fail("encrypted backup contains an invalid final NDJSON row");
    }
    observeRow(metrics, row);
  }

  const actual = {
    ...summarizeMetrics(metrics),
    plaintextSha256: plaintextHash.digest("hex"),
    ciphertextSha256: ciphertextHash.digest("hex"),
  };
  if (actual.rowCount === 0) actual.rowColumns = manifest.rowColumns;
  for (const field of [
    "rowCount",
    "distinctDoujinshi",
    "minId",
    "maxId",
    "rowColumns",
    "plaintextSha256",
    "ciphertextSha256",
  ]) {
    const matches =
      field === "rowColumns"
        ? stableJson(actual[field]) === stableJson(manifest[field])
        : actual[field] === manifest[field];
    if (!matches) {
      fail(`verification failed: ${field} does not match manifest`);
    }
  }
  return actual;
}

function projectConnection(expectedProjectRef) {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !serviceRoleKey) {
    fail(
      "backup mode requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("NEXT_PUBLIC_SUPABASE_URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname.endsWith(".supabase.co")
  ) {
    fail("NEXT_PUBLIC_SUPABASE_URL must be an official HTTPS project URL");
  }
  const projectRef = url.hostname.slice(0, -".supabase.co".length);
  if (!/^[a-z0-9]+$/.test(projectRef)) {
    fail("could not derive a valid Supabase project ref");
  }
  if (projectRef !== expectedProjectRef) {
    fail("Supabase project URL does not match EXPECTED_SUPABASE_PROJECT_REF");
  }
  return { origin: url.origin, projectRef, serviceRoleKey };
}

function isJwtServiceRoleKey(key) {
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)
  ) {
    return false;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(key.split(".")[1], "base64url").toString("utf8")
    );
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

function requestHeaders(serviceRoleKey, accept = "application/json", count = false) {
  const headers = {
    apikey: serviceRoleKey,
    Accept: accept,
    ...(count ? { Prefer: "count=exact" } : {}),
  };
  if (serviceRoleKey.startsWith("sb_secret_")) {
    return headers;
  }
  if (isJwtServiceRoleKey(serviceRoleKey)) {
    return {
      ...headers,
      Authorization: `Bearer ${serviceRoleKey}`,
    };
  }
  fail("SUPABASE_SERVICE_ROLE_KEY must be an sb_secret_ key or legacy JWT");
}

function restUrl(origin, parameters) {
  const url = new URL("/rest/v1/cpp_items", origin);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestCppItems(connection, url, options = {}) {
  let lastMessage = "request failed";
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: requestHeaders(
          connection.serviceRoleKey,
          options.accept,
          options.count
        ),
      });
      if (response.ok) return response;
      lastMessage = `Supabase REST returned HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) break;
    } catch {
      lastMessage = "Supabase REST request failed";
    }
    if (attempt < REQUEST_ATTEMPTS) await delay(250 * 2 ** (attempt - 1));
  }
  fail(lastMessage);
}

async function fetchPostgrestSchemas(connection) {
  const response = await requestCppItems(
    connection,
    new URL("/rest/v1/", connection.origin),
    { accept: "application/openapi+json" }
  );
  let openApiDocument;
  try {
    openApiDocument = await response.json();
  } catch {
    fail("Supabase REST returned invalid OpenAPI JSON");
  }
  const postgrestSchemas = extractPostgrestSchemas(openApiDocument);
  return {
    postgrestSchemas,
    schemaSha256: schemaSha256(postgrestSchemas),
  };
}

async function fetchJson(connection, url) {
  const response = await requestCppItems(connection, url);
  let data;
  try {
    data = await response.json();
  } catch {
    fail("Supabase REST returned invalid JSON");
  }
  if (!Array.isArray(data)) fail("Supabase REST returned an unexpected payload");
  return data;
}

async function snapshotUpperBound(connection) {
  const rows = await fetchJson(
    connection,
    restUrl(connection.origin, {
      select: "id",
      order: "id.desc",
      limit: "1",
    })
  );
  if (rows.length === 0) return null;
  return parseInteger(rows[0]?.id, "cpp_items.id").toString();
}

async function exactCount(connection, upperBound) {
  if (upperBound === null) return 0;
  const response = await requestCppItems(
    connection,
    restUrl(connection.origin, {
      select: "id",
      id: `lte.${upperBound}`,
    }),
    { method: "HEAD", count: true }
  );
  const contentRange = response.headers.get("content-range");
  const match = contentRange?.match(/\/(\d+)$/);
  if (!match) fail("Supabase REST did not return an exact row count");
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count)) fail("Supabase row count is invalid");
  return count;
}

async function* fetchAllRows(connection, upperBound, expectedCount) {
  if (upperBound === null) return;
  let lastId = null;
  let yielded = 0;

  while (true) {
    const idFilter =
      lastId === null
        ? `lte.${upperBound}`
        : undefined;
    const andFilter =
      lastId === null
        ? undefined
        : `(id.gt.${lastId},id.lte.${upperBound})`;
    const rows = await fetchJson(
      connection,
      restUrl(connection.origin, {
        select: "*",
        order: "id.asc",
        limit: String(PAGE_SIZE),
        id: idFilter,
        and: andFilter,
      })
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const id = parseInteger(row?.id, "cpp_items.id");
      if (lastId !== null && id <= BigInt(lastId)) {
        fail("Supabase pagination repeated or skipped its cursor");
      }
      if (id > BigInt(upperBound)) {
        fail("Supabase pagination crossed the snapshot upper bound");
      }
      lastId = id.toString();
      yielded += 1;
      if (yielded > expectedCount) {
        fail("Supabase row count grew within the backup snapshot");
      }
      yield row;
    }
    if (lastId === upperBound) break;
  }

  if (yielded !== expectedCount) {
    fail(
      `Supabase pagination row count mismatch (expected ${expectedCount}, received ${yielded})`
    );
  }
}

function isInsideRepository(targetPath) {
  const relative = path.relative(REPOSITORY_ROOT, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNewBackupTargets(outputPath, manifestPath) {
  if (outputPath === manifestPath) {
    fail("--output and --manifest must be different files");
  }
  if (isInsideRepository(outputPath) || isInsideRepository(manifestPath)) {
    fail("backup output and manifest must be stored outside the repository");
  }
  for (const target of [outputPath, manifestPath]) {
    if (existsSync(target)) fail(`refusing to overwrite existing file: ${target}`);
    await mkdir(path.dirname(target), { recursive: true });
  }
}

async function writeManifest(filePath, manifest, key, expectedProjectRef) {
  manifestMetrics(manifest, key, expectedProjectRef);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) {
    fail("manifest exceeds the safe size limit");
  }
  const fileHandle = await open(filePath, "wx", 0o600);
  try {
    await fileHandle.writeFile(serialized, "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
}

function partialPath(targetPath) {
  return `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.partial`;
}

async function removeIfPresent(targetPath) {
  await rm(targetPath, { force: true }).catch(() => {});
}

async function encryptRowsWithCleanup(rows, partialOutput, key) {
  try {
    return await encryptRows(rows, partialOutput, key);
  } catch (error) {
    await removeIfPresent(partialOutput);
    throw error;
  }
}

async function backupMode(outputPath, manifestPath, key, expectedProjectRef) {
  await assertNewBackupTargets(outputPath, manifestPath);
  const connection = projectConnection(expectedProjectRef);
  const schemaEvidence = await fetchPostgrestSchemas(connection);
  const recoveryEvidence = await loadRecoveryDdl();
  const upperBound = await snapshotUpperBound(connection);
  const expectedCount = await exactCount(connection, upperBound);
  const partialOutput = partialPath(outputPath);
  const partialManifest = partialPath(manifestPath);
  let outputCommitted = false;

  try {
    const encrypted = await encryptRowsWithCleanup(
      fetchAllRows(connection, upperBound, expectedCount),
      partialOutput,
      key
    );
    const finalCount = await exactCount(connection, upperBound);
    if (
      finalCount !== expectedCount ||
      encrypted.rowCount !== expectedCount
    ) {
      fail("cpp_items changed during backup; no backup was committed");
    }

    const expectedRowColumns = schemaColumns(schemaEvidence.postgrestSchemas);
    if (
      encrypted.rowCount > 0 &&
      !equalStringArrays(encrypted.rowColumns, expectedRowColumns)
    ) {
      fail("cpp_items row columns do not match its OpenAPI schema");
    }
    const manifest = addManifestHmac({
      rowCount: encrypted.rowCount,
      distinctDoujinshi: encrypted.distinctDoujinshi,
      minId: encrypted.minId,
      maxId: encrypted.maxId,
      rowColumns: expectedRowColumns,
      plaintextSha256: encrypted.plaintextSha256,
      ciphertextSha256: encrypted.ciphertextSha256,
      postgrestSchemas: schemaEvidence.postgrestSchemas,
      schemaSha256: schemaEvidence.schemaSha256,
      recoveryDdl: recoveryEvidence.recoveryDdl,
      recoveryDdlSha256: recoveryEvidence.recoveryDdlSha256,
      sourceProjectRef: connection.projectRef,
      createdAt: new Date().toISOString(),
      algorithm: ALGORITHM,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
    }, key);
    await writeManifest(partialManifest, manifest, key, expectedProjectRef);
    await rename(partialOutput, outputPath);
    outputCommitted = true;
    await rename(partialManifest, manifestPath);
    return manifest;
  } catch (error) {
    await removeIfPresent(partialOutput);
    await removeIfPresent(partialManifest);
    if (outputCommitted) await removeIfPresent(outputPath);
    throw error;
  }
}

async function verifyMode(outputPath, manifestPath, key, expectedProjectRef) {
  await access(outputPath, fsConstants.R_OK);
  await access(manifestPath, fsConstants.R_OK);
  const manifest = await readManifest(manifestPath, key, expectedProjectRef);
  return verifyEncryptedFile(outputPath, manifest, key, expectedProjectRef);
}

async function selfTest() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cpp-backup-self-test-"));
  const key = randomBytes(32);
  const expectedProjectRef = "fixture";
  const fixtureOpenApi = {
    definitions: Object.fromEntries(
      REQUIRED_SCHEMA_TABLES.map((table) => [
        table,
        {
          type: "object",
          properties:
            table === "cpp_items"
              ? {
                  doujinshi_id: { format: "bigint", type: "integer" },
                  event_id: { type: "string" },
                  id: { format: "bigint", type: "integer" },
                  nullable: { type: "string" },
                  product_name: { type: "string" },
                  tags: { items: { type: "string" }, type: "array" },
                }
              : { id: { type: "string" } },
        },
      ])
    ),
  };
  const fixtureSchemas = extractPostgrestSchemas(fixtureOpenApi);
  const fixtureSchemaSha256 = schemaSha256(fixtureSchemas);
  const fixtureRowColumns = schemaColumns(fixtureSchemas);
  const recoveryEvidence = await loadRecoveryDdl();
  let boundaryEncryptedPath;
  let boundaryManifest;

  function makeRows(count) {
    return Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      event_id: "fixture",
      doujinshi_id: 10_000 + (index % 37),
      product_name: `fixture-${index + 1}`,
      tags: index % 2 === 0 ? ["a"] : [],
      nullable: null,
    }));
  }

  function makeManifest(encrypted) {
    return addManifestHmac(
      {
        rowCount: encrypted.rowCount,
        distinctDoujinshi: encrypted.distinctDoujinshi,
        minId: encrypted.minId,
        maxId: encrypted.maxId,
        rowColumns: fixtureRowColumns,
        plaintextSha256: encrypted.plaintextSha256,
        ciphertextSha256: encrypted.ciphertextSha256,
        postgrestSchemas: fixtureSchemas,
        schemaSha256: fixtureSchemaSha256,
        recoveryDdl: recoveryEvidence.recoveryDdl,
        recoveryDdlSha256: recoveryEvidence.recoveryDdlSha256,
        sourceProjectRef: expectedProjectRef,
        createdAt: new Date().toISOString(),
        algorithm: ALGORITHM,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      },
      key
    );
  }

  try {
    const secretKey = "sb_secret_offline_fixture";
    const secretHeaders = requestHeaders(secretKey);
    assert.equal(secretHeaders.apikey, secretKey);
    assert.equal(secretHeaders.Authorization, undefined);

    const jwtKey =
      "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fixture_signature";
    const jwtHeaders = requestHeaders(jwtKey);
    assert.equal(jwtHeaders.apikey, jwtKey);
    assert.equal(jwtHeaders.Authorization, `Bearer ${jwtKey}`);
    assert.throws(() =>
      requestHeaders(
        "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.fixture_signature"
      )
    );
    assert.throws(() => requestHeaders("unsupported-key"));
    assert.equal(fixtureSchemaSha256.length, 64);
    assert.equal(recoveryEvidence.recoveryDdl.length, 4);

    for (const count of [0, 999, 1000, 1001]) {
      const encryptedPath = path.join(directory, `${count}.enc`);
      const manifestPath = path.join(directory, `${count}.manifest.json`);
      const rows = makeRows(count);
      const encrypted = await encryptRows(rows, encryptedPath, key);
      if (count > 0) {
        assert.deepEqual(encrypted.rowColumns, fixtureRowColumns);
      }
      const manifest = makeManifest(encrypted);
      await writeManifest(
        manifestPath,
        manifest,
        key,
        expectedProjectRef
      );
      await verifyMode(encryptedPath, manifestPath, key, expectedProjectRef);
      if (count === 1000) {
        boundaryEncryptedPath = encryptedPath;
        boundaryManifest = manifest;
      }
    }

    const manifestTamper = structuredClone(boundaryManifest);
    manifestTamper.createdAt = new Date(Date.now() + 1000).toISOString();
    await assert.rejects(() =>
      verifyEncryptedFile(
        boundaryEncryptedPath,
        manifestTamper,
        key,
        expectedProjectRef
      )
    );

    const schemaTamper = structuredClone(boundaryManifest);
    schemaTamper.postgrestSchemas.cpp_items.properties.injected = {
      type: "string",
    };
    schemaTamper.manifestHmac = manifestHmacSha256(schemaTamper, key);
    await assert.rejects(() =>
      verifyEncryptedFile(
        boundaryEncryptedPath,
        schemaTamper,
        key,
        expectedProjectRef
      )
    );

    const missingRowColumn = structuredClone(boundaryManifest);
    missingRowColumn.rowColumns = missingRowColumn.rowColumns.slice(1);
    missingRowColumn.manifestHmac = manifestHmacSha256(missingRowColumn, key);
    await assert.rejects(() =>
      verifyEncryptedFile(
        boundaryEncryptedPath,
        missingRowColumn,
        key,
        expectedProjectRef
      )
    );

    const ddlTamper = structuredClone(boundaryManifest);
    ddlTamper.recoveryDdl[0].content += "\n-- tampered";
    ddlTamper.manifestHmac = manifestHmacSha256(ddlTamper, key);
    await assert.rejects(() =>
      verifyEncryptedFile(
        boundaryEncryptedPath,
        ddlTamper,
        key,
        expectedProjectRef
      )
    );

    await assert.rejects(() =>
      verifyEncryptedFile(
        boundaryEncryptedPath,
        boundaryManifest,
        randomBytes(32),
        expectedProjectRef
      )
    );
    await assert.rejects(() =>
      verifyEncryptedFile(
        boundaryEncryptedPath,
        boundaryManifest,
        key,
        "wrong-project"
      )
    );

    const tamperHandle = await open(boundaryEncryptedPath, "r+");
    try {
      const firstByte = Buffer.alloc(1);
      const { bytesRead } = await tamperHandle.read(firstByte, 0, 1, 0);
      assert.equal(bytesRead, 1);
      firstByte[0] ^= 0xff;
      await tamperHandle.write(firstByte, 0, 1, 0);
      await tamperHandle.sync();
    } finally {
      await tamperHandle.close();
    }
    await assert.rejects(() =>
      verifyEncryptedFile(
        boundaryEncryptedPath,
        boundaryManifest,
        key,
        expectedProjectRef
      )
    );

    const failedPartial = path.join(directory, "expected-failure.partial");
    await assert.rejects(() =>
      encryptRowsWithCleanup(
        [
          { id: 1, doujinshi_id: 1, product_name: "one" },
          { id: 2, doujinshi_id: 2 },
        ],
        failedPartial,
        key
      )
    );
    await assert.rejects(() => access(failedPartial, fsConstants.F_OK));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      output: { type: "string" },
      manifest: { type: "string" },
      "self-test": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values["self-test"]) {
    await selfTest();
    console.log("Encrypted backup offline self-test passed.");
    return;
  }
  if (!["backup", "verify"].includes(values.mode)) {
    fail("--mode must be backup or verify");
  }
  if (!values.output || !values.manifest) {
    fail("--output and --manifest are required");
  }

  const outputPath = path.resolve(values.output);
  const manifestPath = path.resolve(values.manifest);
  const key = loadKey();
  const expectedProjectRef = loadExpectedProjectRef();
  if (values.mode === "backup") {
    const manifest = await backupMode(
      outputPath,
      manifestPath,
      key,
      expectedProjectRef
    );
    console.log(
      `Encrypted backup created and authenticated (${manifest.rowCount} rows).`
    );
  } else {
    const verified = await verifyMode(
      outputPath,
      manifestPath,
      key,
      expectedProjectRef
    );
    console.log(`Encrypted backup verified (${verified.rowCount} rows).`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : "operation failed"}`);
  process.exitCode = 1;
});
