import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';

interface ExpressLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
  name?: string;
  handle?: {
    stack?: ExpressLayer[];
  };
  regexp?: RegExp;
}

function normalizeExpressPath(raw: string): string {
  return raw
    .replace(/\/+/g, '/')
    .replace(/:([a-zA-Z0-9_]+)/g, '{$1}')
    .replace(/\/$/, '') || '/';
}

function collectExpressRoutes(app: ReturnType<typeof createApp>): Set<string> {
  const routes = new Set<string>();

  function walk(stack: ExpressLayer[], prefix: string) {
    for (const layer of stack) {
      if (layer.route) {
        const fullPath = normalizeExpressPath(`${prefix}${layer.route.path}`);
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) {
            routes.add(`${method.toUpperCase()} ${fullPath}`);
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Extraemos el prefijo del regexp de Express
        const src = layer.regexp?.source ?? '';
        const match = /\^\\\/([a-zA-Z0-9_\\/-]+)\??\\\/\?\(\?=\\\/\|\$\)/.exec(src);
        let segment = '';
        if (match && match[1]) {
          segment = '/' + match[1].replace(/\\\//g, '/');
        } else {
          const clean = src
            .replace(/^\^/, '')
            .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
            .replace(/\\\//g, '/')
            .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, '{param}');
          if (clean.startsWith('/')) {
            segment = clean;
          }
        }
        walk(layer.handle.stack, `${prefix}${segment}`);
      }
    }
  }

  const routerStack = (app as unknown as { _router?: { stack?: ExpressLayer[] } })
    ._router?.stack;
  if (routerStack) {
    walk(routerStack, '');
  }
  return routes;
}

async function main() {
  const specPath = path.resolve(process.cwd(), 'docs/api/openapi.yaml');
  if (!fs.existsSync(specPath)) {
    throw new Error(`No se encontró ${specPath}`);
  }

  const raw = fs.readFileSync(specPath, 'utf8');
  const spec = YAML.parse(raw) as {
    openapi?: string;
    paths?: Record<string, Record<string, unknown>>;
  };

  if (!spec.openapi || !spec.paths) {
    throw new Error('El archivo OpenAPI no tiene secciones válidas openapi/paths');
  }

  const db = createDatabase({ pgliteDir: ':memory:' });
  try {
    const app = createApp(db, { enableRateLimit: false });
    const implemented = collectExpressRoutes(app);

    const missing: string[] = [];
    let totalSpecOperations = 0;

    const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    for (const [specPathKey, operations] of Object.entries(spec.paths)) {
      for (const method of Object.keys(operations)) {
        if (!httpMethods.has(method.toLowerCase())) continue;
        totalSpecOperations += 1;
        const expected = `${method.toUpperCase()} /api/v1${specPathKey}`;
        if (!implemented.has(expected)) {
          missing.push(expected);
        }
      }
    }

    if (missing.length > 0) {
      console.error('Faltan rutas declaradas en docs/api/openapi.yaml:');
      for (const item of missing) {
        console.error(`  - ${item}`);
      }
      process.exit(1);
    }

    console.log(
      `Validación OpenAPI exitosa: ${totalSpecOperations}/${totalSpecOperations} operaciones de docs/api/openapi.yaml implementadas bajo /api/v1.`,
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('Error validando OpenAPI:', err);
  process.exit(1);
});
