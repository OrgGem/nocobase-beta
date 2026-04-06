const { existsSync, mkdirSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');

const modelId = 'Xenova/all-MiniLM-L6-v2';
const revision = 'main';
const files = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_q8.onnx',
];

const destBase = join(process.cwd(), 'dist/models', modelId, 'resolve', revision);

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  const arrayBuffer = await res.arrayBuffer();
  const dir = dirname(dest);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(dest, Buffer.from(arrayBuffer));
}

(async () => {
  for (const file of files) {
    const url = `https://huggingface.co/${modelId}/resolve/${revision}/${file}`;
    const destPath = join(destBase, file);
    if (existsSync(destPath)) {
      console.log('Already downloaded', file);
      continue;
    }
    console.log('Downloading', file, '...');
    await download(url, destPath);
  }
  console.log('Done downloading model');
})().catch(console.error);
