import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Run after expo prebuild. This checks native config, not Java compilation or signing. */
async function main() {
  const root = join(process.cwd(), 'android');
  const manifest = await readFile(join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android:name="android.permission.INTERNET"/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.doesNotMatch(manifest, /android:fullBackupContent=/);
  assert.doesNotMatch(manifest, /android:dataExtractionRules=/);
  for (const permission of [
    'CAMERA',
    'RECORD_AUDIO',
    'READ_EXTERNAL_STORAGE',
    'WRITE_EXTERNAL_STORAGE',
  ]) {
    const expression = new RegExp(
      `<uses-permission[^>]*android:name="android.permission.${permission}"[^>]*tools:node="remove"`,
    );
    assert.match(
      manifest,
      expression,
      `${permission} must be explicitly removed in the current phase`,
    );
  }
  for (const match of manifest.matchAll(/@xml\/([a-zA-Z0-9_]+)/g)) {
    await access(join(root, 'app/src/main/res/xml', `${match[1]}.xml`));
  }
  assert.match(manifest, /<data[^>]*android:scheme="ownerbook"/);
  const gradle = await readFile(join(root, 'app/build.gradle'), 'utf8');
  assert.match(gradle, /applicationId\s+['"]app\.ownerbook\.mobile['"]/);
  console.log('Android native configuration checks passed. This is not an APK compilation test.');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
