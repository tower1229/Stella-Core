import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Offline compiler fixture. The actual entry and compiler orchestration run;
 * this synthetic tsc only emits explicitly supplied, synthetic test files. */
export async function installWorkspaceTestEntry(root: string, files: Record<string, string>) {
  await mkdir(path.join(root, "scripts"), { recursive: true });
  for (const name of ["compile.mjs", "run-workspace-tests.mjs"])
    await cp(new URL(`../../scripts/${name}`, import.meta.url), path.join(root, "scripts", name));
  await cp(new URL("../../scripts/lib", import.meta.url), path.join(root, "scripts/lib"), { recursive: true });
  const directory = path.join(root, "node_modules/typescript/bin"); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "tsc"), `const fs=require('node:fs'),path=require('node:path');
const mode=process.argv[3]==='tsconfig.build.json'?'build':'test';
if(process.env.STELLA_TEST_COMPILE_CALLS)fs.appendFileSync(process.env.STELLA_TEST_COMPILE_CALLS,JSON.stringify(['compile-'+mode])+'\\n');
if(process.env.STELLA_TEST_COMPILE_FAIL===mode)process.exit(7);
const output=path.resolve(mode==='build'?'dist':'.test-dist');fs.mkdirSync(output,{recursive:true});
if(mode==='test')for(const [name,body]of Object.entries(${JSON.stringify(files)})){const file=path.join(output,'tests',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}`);
}
