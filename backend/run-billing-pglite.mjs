// Local PostgreSQL adapter for the existing billing regression script.
// node --experimental-test-module-mocks run-billing-pglite.mjs
import {mock} from 'node:test';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const database=new PGlite();
class Pool {
  async query(sql,args){const result=await database.query(sql,args);return {...result,rowCount:result.affectedRows ?? result.rows.length};}
  async connect(){return {query:this.query.bind(this),release(){}};}
  async end(){await database.close();}
}
mock.module('pg',{defaultExport:{Pool}});
process.env.DATABASE_URL='postgres://local-test-only';
await import('./test-billing.mjs');
