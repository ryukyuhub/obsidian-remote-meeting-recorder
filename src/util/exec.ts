import { execFile } from "child_process";
import { promisify } from "util";

/** execFile の Promise 版（stdout/stderr を返す）。外部バイナリ実行で共用。 */
export const execFileAsync = promisify(execFile);
