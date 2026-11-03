import { DatabaseSync } from "node:sqlite";
const original = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql, ...args) {
  try { return Reflect.apply(original, this, [sql, ...args]); }
  catch (error) {
    if (typeof sql === "string" && sql.includes("JOIN undefined AS source"))
      process.stderr.write("SQL_CAUSE " + JSON.stringify({site:"JOIN source", missingPublicConstant:true, errorCode:error.code, undefinedTable:error.message === "no such table: undefined"}) + "\n");
    throw error;
  }
};
