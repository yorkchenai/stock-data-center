import { readFileSync } from "node:fs";
import { passwordVerifier } from "../worker/portfolio/auth.mjs";

if (process.stdin.isTTY || process.argv.length !== 2) throw new Error("请从关闭回显的输入读取密码，再通过 stdin 传给此脚本。");
const password=readFileSync(0,"utf8").replace(/\r?\n$/,"");
process.stdout.write(await passwordVerifier(password)+"\n");
