// ============================================================
// Семейное дерево — Worker + статика в одном файле
// Обрабатывает /api/data сам, всё остальное отдаёт через ASSETS
// ============================================================

const FAMILY_CODE = 'Наша семья';
const ADMIN_CODE  = 'admin2024';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth',
    'Content-Type': 'application/json',
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors() });
}
const EMPTY = { members: [], suggestions: [], title: 'Семейное дерево' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (request.method === 'GET' && url.pathname === '/api/data') {
      try {
        const row = await env.DB.prepare(
          "SELECT value FROM data WHERE key = 'family_data'"
        ).first();
        return json(row ? JSON.parse(row.value) : EMPTY);
      } catch (e) {
        return json(EMPTY);
      }
    }

    if (request.method === 'PUT' && url.pathname === '/api/data') {
      const auth = (request.headers.get('X-Auth') || '').trim().toLowerCase();
      if (auth !== FAMILY_CODE.trim().toLowerCase() && auth !== ADMIN_CODE.trim().toLowerCase()) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const body = await request.json();
      if (!Array.isArray(body.members) || !Array.isArray(body.suggestions)) {
        return json({ error: 'Invalid data' }, 400);
      }
      await env.DB.prepare(
        "INSERT OR REPLACE INTO data (key, value) VALUES ('family_data', ?)"
      ).bind(JSON.stringify(body)).run();
      return json({ ok: true });
    }

    // Всё остальное — отдаём статические файлы (index.html и т.д.)
    return env.ASSETS.fetch(request);
  },
};
