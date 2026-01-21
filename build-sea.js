// build-sea.js - Node.js SEA (Single Executable Application) builder
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { platform } from 'os';

const execAsync = promisify(exec);
const isWindows = platform() === 'win32';
const exeExt = isWindows ? '.exe' : '';

async function build() {
  console.log('Building AIRON executable with Node.js SEA...\n');

  try {
    // Step 0: Ensure dist directory exists
    if (!existsSync('dist')) {
      await fs.mkdir('dist');
    }

    // Step 1: Bundle with esbuild (all modules included via static imports)
    console.log('1. Bundling with esbuild...');
    await execAsync('npx esbuild src/airon.js --bundle --platform=node --format=cjs --outfile=dist/airon-bundled.cjs');
    console.log('   ✓ Created dist/airon-bundled.cjs');

    // Step 2: Create sea-config.json
    const seaConfig = {
      main: 'dist/airon-bundled.cjs',
      output: 'dist/sea-prep.blob',
      disableExperimentalSEAWarning: true
    };

    await fs.writeFile('sea-config.json', JSON.stringify(seaConfig, null, 2));
    console.log('2. Created sea-config.json');

    // Step 3: Generate blob
    console.log('3. Generating SEA blob...');
    await execAsync('node --experimental-sea-config sea-config.json');
    console.log('   ✓ Generated sea-prep.blob');

    // Step 4: Copy node executable
    console.log('4. Copying Node.js executable...');
    const nodePath = process.execPath;
    const outputExe = `dist/airon${exeExt}`;
    await fs.copyFile(nodePath, outputExe);
    console.log(`   ✓ Copied to ${outputExe}`);

    // Step 5: Remove signature (Windows only, required for injection)
    if (isWindows) {
      console.log('5. Removing signature...');
      try {
        await execAsync('npx -y node-signtool remove dist/airon.exe');
        console.log('   ✓ Signature removed');
      } catch (e) {
        console.log('   (Signature removal not needed or failed - continuing...)');
      }
    } else {
      console.log('5. Skipping signature removal (not Windows)');
    }

    // Step 6: Inject blob
    console.log('6. Injecting SEA blob...');
    const postjectCmd = isWindows
      ? `npx -y postject dist/airon.exe NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`
      : `npx -y postject dist/airon NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`;
    await execAsync(postjectCmd);
    console.log('   ✓ Injected blob into executable');

    // Cleanup
    await fs.unlink('sea-config.json');
    await fs.unlink('dist/sea-prep.blob');

    // Get file size
    const stats = await fs.stat(outputExe);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

    console.log(`\n✅ Build complete!`);
    console.log(`   Output: ${outputExe} (${sizeMB} MB)`);
    console.log(`   Test:   .\\dist\\airon${exeExt} --help`);

  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    if (error.stderr) console.error(error.stderr);
    process.exit(1);
  }
}

build();
