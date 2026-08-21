// Recipe + comic storage. Render's free web services have no persistent
// disk, so everything durable lives in Postgres - including the comic
// images, which are served back out of the database as binary.

import pg from "pg";

const { Pool } = pg;

let pool = null;

export function dbConfigured(){
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(){
  if(!pool){
    if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render's managed Postgres terminates TLS with its own CA.
      ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 4),
      idleTimeoutMillis: 30000
    });
  }
  return pool;
}

export async function query(text, params){
  return getPool().query(text, params);
}

export async function initSchema(){
  await query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id          TEXT PRIMARY KEY,
      slug        TEXT NOT NULL,
      title       TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'Other',
      contributor TEXT NOT NULL DEFAULT '',
      data        JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS recipes_title_idx ON recipes (lower(title))`);
  await query(`CREATE INDEX IF NOT EXISTS recipes_category_idx ON recipes (category)`);
  await query(`
    CREATE TABLE IF NOT EXISTS comic_images (
      id         TEXT PRIMARY KEY,
      recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      idx        INTEGER NOT NULL,
      mime       TEXT NOT NULL,
      bytes      BYTEA NOT NULL,
      captions   JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // Added after the first release; existing installs need the column.
  await query(`ALTER TABLE comic_images ADD COLUMN IF NOT EXISTS captions JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await query(`CREATE INDEX IF NOT EXISTS comic_images_recipe_idx ON comic_images (recipe_id)`);

  // Art that could not be drawn now - usually the daily image allowance is
  // spent - waits here instead of being silently dropped.
  await query(`
    CREATE TABLE IF NOT EXISTS art_jobs (
      recipe_id  TEXT PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
      status     TEXT NOT NULL DEFAULT 'pending',
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      run_after  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS art_jobs_pending_idx ON art_jobs (status, run_after)`);
}

// --- recipes ---------------------------------------------------------------

export async function listRecipes(){
  const { rows } = await query(
    `SELECT data, created_at, updated_at FROM recipes ORDER BY lower(title)`);
  return rows.map(row => ({
    ...row.data,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }));
}

export async function getRecipe(id){
  const { rows } = await query(`SELECT data, updated_at FROM recipes WHERE id = $1`, [id]);
  if(rows.length === 0) return null;
  return { ...rows[0].data, updatedAt: rows[0].updated_at.toISOString() };
}

export async function upsertRecipe(recipe){
  const { rows } = await query(
    `INSERT INTO recipes (id, slug, title, category, contributor, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
       SET slug = EXCLUDED.slug, title = EXCLUDED.title,
           category = EXCLUDED.category, contributor = EXCLUDED.contributor,
           data = EXCLUDED.data, updated_at = now()
     RETURNING data, updated_at`,
    [recipe.id, recipe.slug, recipe.title, recipe.category, recipe.contributor || "", recipe]
  );
  return { ...rows[0].data, updatedAt: rows[0].updated_at.toISOString() };
}

export async function deleteRecipe(id){
  const { rowCount } = await query(`DELETE FROM recipes WHERE id = $1`, [id]);
  return rowCount > 0;
}

// --- comic images ----------------------------------------------------------

export async function putComicImage({ id, recipeId, idx, mime, base64, captions = [] }){
  await query(
    `INSERT INTO comic_images (id, recipe_id, idx, mime, bytes, captions)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
       SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
           captions = EXCLUDED.captions, created_at = now()`,
    [id, recipeId, idx, mime, Buffer.from(base64, "base64"), JSON.stringify(captions)]
  );
  return id;
}

export async function getComicImage(id){
  const { rows } = await query(
    `SELECT mime, bytes, captions FROM comic_images WHERE id = $1`, [id]);
  return rows.length ? rows[0] : null;
}

// Lettering is composed at serve time, so captions can be corrected without
// redrawing the art.
export async function setComicCaptions(id, captions){
  const { rowCount } = await query(
    `UPDATE comic_images SET captions = $2 WHERE id = $1`, [id, JSON.stringify(captions)]);
  return rowCount > 0;
}

export async function deleteComicImages(recipeId){
  await query(`DELETE FROM comic_images WHERE recipe_id = $1`, [recipeId]);
}

export async function stats(){
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM recipes)::int       AS recipes,
      (SELECT count(*) FROM comic_images)::int  AS images,
      (SELECT coalesce(sum(length(bytes)),0) FROM comic_images)::bigint AS image_bytes`);
  return {
    recipes: rows[0].recipes,
    images: rows[0].images,
    imageBytes: Number(rows[0].image_bytes)
  };
}


// --- art queue -------------------------------------------------------------

export async function enqueueArt(recipeId, reason = ""){
  await query(
    `INSERT INTO art_jobs (recipe_id, status, last_error, run_after)
     VALUES ($1, 'pending', $2, now())
     ON CONFLICT (recipe_id) DO UPDATE
       SET status = 'pending', last_error = EXCLUDED.last_error, run_after = now()`,
    [recipeId, reason.slice(0, 400)]
  );
}

// Claims one job so two workers cannot pick up the same recipe.
export async function claimArtJob(){
  const { rows } = await query(
    `UPDATE art_jobs SET status = 'running', attempts = attempts + 1
      WHERE recipe_id = (
        SELECT recipe_id FROM art_jobs
         WHERE status = 'pending' AND run_after <= now()
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING recipe_id, attempts`);
  return rows[0] || null;
}

export async function finishArtJob(recipeId){
  await query(`DELETE FROM art_jobs WHERE recipe_id = $1`, [recipeId]);
}

// Failed jobs back off rather than spinning against a spent allowance.
export async function failArtJob(recipeId, error, retryInMinutes = 30){
  await query(
    `UPDATE art_jobs
        SET status = 'pending', last_error = $2,
            run_after = now() + ($3 || ' minutes')::interval
      WHERE recipe_id = $1`,
    [recipeId, String(error).slice(0, 400), String(retryInMinutes)]);
}

export async function queuedRecipeIds(){
  const { rows } = await query(`SELECT recipe_id FROM art_jobs`);
  return rows.map(r => r.recipe_id);
}

export async function artQueueDepth(){
  const { rows } = await query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE status = 'pending')::int pending
       FROM art_jobs`);
  return rows[0];
}
