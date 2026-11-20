// A small CRUD collection (Postman v2.1) for the §22 host tests: todos (list, create, get, patch, put, delete) and a
// static login.
const J = { key: 'Content-Type', value: 'application/json' };
const url = (path: string[]) => ({ raw: `{{baseUrl}}/${path.join('/')}`, host: ['{{baseUrl}}'], path });

export function todoCollection(baseUrl = 'http://api.todo.test', extraHeaders: { key: string; value: string }[] = []): string {
  return JSON.stringify({
    info: { name: 'Todo API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'baseUrl', value: baseUrl }],
    item: [
      {
        name: 'List todos',
        request: { method: 'GET', url: url(['todos']) },
        response: [{ name: 'OK', code: 200, header: [J, ...extraHeaders], body: JSON.stringify([{ id: 1, title: 'Milk', done: false }, { id: 2, title: 'Eggs', done: true }]) }],
      },
      {
        name: 'Create todo',
        request: { method: 'POST', url: url(['todos']) },
        response: [{ name: 'Created', code: 201, header: [J, ...extraHeaders], body: JSON.stringify({ id: 3, title: 'Bread', done: false, createdAt: '2026-01-01' }) }],
      },
      {
        name: 'Get todo',
        request: { method: 'GET', url: url(['todos', ':id']) },
        response: [
          { name: 'OK', code: 200, header: [J, ...extraHeaders], body: JSON.stringify({ id: 1, title: 'Milk', done: false }) },
          { name: 'Not found', code: 404, header: [J], body: JSON.stringify({ error: 'gone' }) },
        ],
      },
      { name: 'Update todo', request: { method: 'PATCH', url: url(['todos', ':id']) }, response: [{ name: 'OK', code: 200, header: [J], body: JSON.stringify({ id: 1, title: 'Milk', done: true }) }] },
      { name: 'Delete todo', request: { method: 'DELETE', url: url(['todos', ':id']) }, response: [{ name: 'Deleted', code: 204, header: [], body: '' }] },
      { name: 'Log in', request: { method: 'POST', url: url(['auth', 'login']) }, response: [{ name: 'OK', code: 200, header: [J], body: '{"token":"t"}' }] },
    ],
  });
}
