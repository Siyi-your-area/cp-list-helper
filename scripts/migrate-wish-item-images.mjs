#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "wish-item-images";
const BATCH_SIZE = 4;
const WORKERS = 4;
const CREATE_BUCKET_ONLY = process.argv.includes("--create-bucket-only");
const MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

function loadEnvFile(filename) {
  if (!existsSync(filename)) return;
  for (const line of readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value.replace(/\\n/g, "\n");
  }
}

loadEnvFile(path.join(process.cwd(), ".env.local"));
loadEnvFile(path.join(process.cwd(), ".dev.vars"));

const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "")
  .replace(/\/rest\/v1\/?$/, "");
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_CPP_SYNC_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error("缺少 Supabase URL 或服务端 Secret Key");

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function ensureBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;
  if (buckets?.some((bucket) => bucket.id === BUCKET)) return false;
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: [...MIME_EXTENSIONS.keys()],
  });
  if (error) throw error;
  return true;
}

function decodeDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error("不支持的 Base64 图片格式");
  const mimeType = match[1];
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) throw new Error("图片为空或超过 5MB");
  return { mimeType, bytes, extension: MIME_EXTENSIONS.get(mimeType) };
}

async function migrateRow(row) {
  const { mimeType, bytes, extension } = decodeDataUrl(row.image_url);
  const objectPath = `legacy/${row.event_id}/${row.id}.${extension}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(objectPath, bytes, {
    contentType: mimeType,
    cacheControl: "31536000",
    upsert: true,
  });
  if (uploadError) throw uploadError;

  const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
  const { data: replaced, error: replaceError } = await supabase.rpc("replace_wish_item_inline_image", {
    p_item_id: row.id,
    p_expected_version: row.version,
    p_image_url: publicData.publicUrl,
  });
  if (replaceError) throw replaceError;
  return replaced ? "updated" : "skipped";
}

const created = await ensureBucket();
console.log(created ? "已创建 wish-item-images Bucket" : "wish-item-images Bucket 已存在");
if (CREATE_BUCKET_ONLY) process.exit(0);

const totals = { found: 0, updated: 0, skipped: 0, failed: 0 };
while (true) {
  const { data: rows, error } = await supabase.rpc("list_wish_item_inline_images", { p_limit: BATCH_SIZE });
  if (error) throw error;
  if (!rows?.length) break;
  totals.found += rows.length;
  let batchUpdated = 0;

  for (let offset = 0; offset < rows.length; offset += WORKERS) {
    const results = await Promise.allSettled(rows.slice(offset, offset + WORKERS).map(migrateRow));
    results.forEach((result) => {
      if (result.status === "fulfilled") {
        totals[result.value] += 1;
        if (result.value === "updated") batchUpdated += 1;
      }
      else {
        totals.failed += 1;
        console.error(`迁移失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    });
  }

  console.log(`进度：已更新 ${totals.updated}，跳过 ${totals.skipped}，失败 ${totals.failed}`);
  if (batchUpdated === 0) break;
}

console.log(`迁移完成：发现 ${totals.found}，更新 ${totals.updated}，跳过 ${totals.skipped}，失败 ${totals.failed}`);
if (totals.failed > 0) process.exitCode = 1;
