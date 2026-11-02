import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const limit = 350 * 1024;

function loadCompressor({ webpSupported = true, transparent = false, encodedSize = 120_000 } = {}) {
  const calls = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, transparent ? 128 : 255]) }),
      fillRect() {},
    }),
    toBlob(callback, type) {
      calls.push(type);
      const actualType = type === "image/webp" && !webpSupported ? "image/png" : type;
      callback(new Blob([new Uint8Array(encodedSize)], { type: actualType }));
    },
  };
  class MockImage {
    naturalWidth = 2000;
    naturalHeight = 1000;
    set src(_value) { queueMicrotask(() => this.onload()); }
  }
  const compiled = ts.transpileModule(source("lib/wish-item-image-compression.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const fakeRequire = () => ({
    WISH_ITEM_UPLOAD_MAX_BYTES: limit,
    IMAGE_TOO_LARGE_MESSAGE: "图片压缩后仍超过 350 KB",
  });
  const mockUrl = { createObjectURL: () => "blob:test", revokeObjectURL() {} };
  Function("require", "module", "exports", "URL", "Image", "document", "File", compiled)(
    fakeRequire, module, module.exports, mockUrl, MockImage,
    { createElement: () => canvas }, File
  );
  return { compressImage: module.exports.compressImage, calls };
}

test("新 PNG 优先转为 WebP，并保持 350 KB 内", async () => {
  const { compressImage, calls } = loadCompressor();
  const output = await compressImage(new File([new Uint8Array(900_000)], "source.png", { type: "image/png" }));
  assert.equal(output.type, "image/webp");
  assert.ok(output.size <= limit);
  assert.deepEqual(calls, ["image/webp"]);
});

test("不支持 WebP 编码时，非透明图片退回 JPEG", async () => {
  const { compressImage, calls } = loadCompressor({ webpSupported: false });
  const output = await compressImage(new File([new Uint8Array(900_000)], "source.png", { type: "image/png" }));
  assert.equal(output.type, "image/jpeg");
  assert.deepEqual(calls, ["image/webp", "image/jpeg"]);
});

test("浏览器可解码的 HEIC 照片会转码，不把不支持的原格式直接上传", async () => {
  const { compressImage } = loadCompressor();
  const output = await compressImage(new File([new Uint8Array(200_000)], "source.heic", { type: "image/heic" }));
  assert.equal(output.type, "image/webp");
});

test("透明图片退回 PNG；压缩后超限必须报错，不上传原图", async () => {
  const { compressImage, calls } = loadCompressor({ webpSupported: false, transparent: true, encodedSize: 400_000 });
  await assert.rejects(
    compressImage(new File([new Uint8Array(900_000)], "source.png", { type: "image/png" })),
    /超过 350 KB/
  );
  assert.equal(calls[1], "image/png");
});

test("服务端与前端使用同一 350 KB 上限", () => {
  assert.match(source("app/api/wish-items/image/route.ts"), /file\.size > WISH_ITEM_UPLOAD_MAX_BYTES/);
  assert.match(source("lib/wish-item-image-upload.ts"), /uploadFile\.size > WISH_ITEM_UPLOAD_MAX_BYTES/);
});
