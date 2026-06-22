const postgres = require('../config/postgres');

export const db = postgres.db;
export const pool = postgres.pool;
export const query = postgres.query;
