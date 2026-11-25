import { Database } from '../database/database';
(async () => {
  const db = new Database(':memory:');
  await db.initialize();
  const rows: any[] = await new Promise((res,rej)=> (db as any).db.all("PRAGMA table_info(scheduled_notifications)", (e,r)=>e?rej(e):res(r)));
  console.log(rows.map(r=>r.name).join(','));
  await db.close();
})();
