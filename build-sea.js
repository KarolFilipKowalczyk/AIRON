// build-sea.js - Node.js SEA (Single Executable Application) builder
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);

async function build() {
  console.log('Building AIRON executable with Node.js SEA...');
  
  try {
    // Step 1: Create sea-config.json
    const seaConfig = {
      main: 'dist/airon-bundled.cjs',
      output: 'dist/sea-prep.blob',
      disableExperimentalSEAWarning: true
    };
    
    await fs.writeFile('sea-config.json', JSON.stringify(seaConfig, null, 2));
    console.log('✓ Created sea-config.json');
    
    // Step 2: Generate blob
    console.log('Generating SEA blob...');
    await execAsync('node --experimental-sea-config sea-config.json');
    console.log('✓ Generated sea-prep.blob');
    
    // Step 3: Copy node executable
    console.log('Copying Node.js executable...');
    const nodePath = process.execPath;
    await fs.copyFile(nodePath, 'dist/airon.exe');
    console.log('✓ Copied node.exe to dist/airon.exe');
    
    // Step 4: Remove signature (required for injection)
    console.log('Removing signature...');
    try {
      await execAsync('npx -y node-signtool remove dist/airon.exe');
    } catch (e) {
      console.log('  (Signature removal not needed or failed - continuing...)');
    }
    
    // Step 5: Inject blob (Windows-specific using postject)
    console.log('Injecting SEA blob...');
    await execAsync('npx -y postject dist/airon.exe NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
    console.log('✓ Injected blob into executable');
    
    // Cleanup
    await fs.unlink('sea-config.json');
    await fs.unlink('dist/sea-prep.blob');
    
    console.log('\n✅ Build complete! Executable: dist/airon.exe');
    console.log('   Test with: .\\dist\\airon.exe --help');
    
  } catch (error) {
    console.error('❌ Build failed:', error.message);
    if (error.stderr) console.error(error.stderr);
    process.exit(1);
  }
}

build();
