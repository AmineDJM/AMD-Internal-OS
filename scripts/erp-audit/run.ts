/**
 * GÉNÉRATEUR DE LA CARTE DE L'ERP.
 *
 *   npx tsx scripts/erp-audit/run.ts
 *
 * Écrit `docs/api/erp-map.json` (machine) et `docs/api/ERP_AUDIT.md` (humain). Les deux se
 * REGÉNÈRENT : aucune ligne n'est tenue à la main, donc aucune ne peut mentir sur un code qui
 * a bougé depuis. C'est cette carte qui sert ensuite de référence à la couverture de l'API.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { MODULES, ACTIONS, PERMISSIONS } from "../../src/lib/rbac";
import { NAVIGATION, ROLE_LABELS } from "../../src/lib/labels";
import { FEATURES } from "../../src/lib/features";
import {
  parsePrismaModels, parsePrismaEnums, parseServerActions, parsePage, parseApiRoute,
  parseScheduledJobs, parseExportedFunctions,
  type PrismaModel, type PrismaEnum, type ServerAction, type PageInfo, type ApiRoute,
} from "./extract";

const ROOT = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "api");
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), "utf8");

/** Parcours récursif d'un dossier, chemins relatifs à la racine du dépôt. */
function walk(dir: string, match: (f: string) => boolean): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel, match));
    else if (match(entry.name)) out.push(rel);
  }
  return out;
}

export interface ErpMap {
  generatedAt: string;
  counts: Record<string, number>;
  modules: { name: string; roles: Record<string, string[]> }[];
  rbacActions: readonly string[];
  roles: { role: string; label: string; modules: string[] }[];
  navigation: unknown;
  pages: PageInfo[];
  apiRoutes: ApiRoute[];
  actions: ServerAction[];
  queries: { file: string; functions: string[] }[];
  models: PrismaModel[];
  enums: PrismaEnum[];
  scheduledJobs: { name: string; note: string | null }[];
  featureFlags: { key: string; label: string; description: string }[];
  workflowFiles: string[];
}

function build(): ErpMap {
  const schema = read("prisma/schema.prisma");
  const enums = parsePrismaEnums(schema);
  const models = parsePrismaModels(schema, new Set(enums.map((e) => e.name)));

  const pages = walk("src/app", (f) => f === "page.tsx").map((f) => parsePage(f, read(f)));
  const apiRoutes = walk("src/app/api", (f) => f === "route.ts").map((f) => parseApiRoute(f, read(f)));

  const actionFiles = walk("src/lib/actions", (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const actions = actionFiles.flatMap((f) => parseServerActions(f, read(f)));

  const queries = walk("src/lib/queries", (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, functions: parseExportedFunctions(read(f)) }));

  const scheduledJobs = parseScheduledJobs(read("src/lib/scheduled.ts"));

  // Les rôles se lisent dans la matrice elle-même : y tenir une seconde liste, c'est
  // garantir qu'un rôle ajouté un jour manque à la carte.
  const ROLES_ALL = Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[];
  const roles = ROLES_ALL.map((role) => ({
    role,
    label: ROLE_LABELS[role] ?? role,
    modules: Object.keys(PERMISSIONS[role] ?? {}),
  }));

  const modules = MODULES.map((name) => ({
    name,
    roles: Object.fromEntries(
      ROLES_ALL
        .map((r) => [r, (PERMISSIONS[r] as Record<string, string[]>)?.[name] ?? []] as const)
        .filter(([, acts]) => acts.length > 0),
    ),
  }));

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      modules: MODULES.length,
      roles: roles.length,
      pages: pages.length,
      apiRoutes: apiRoutes.length,
      serverActions: actions.length,
      queryModules: queries.length,
      queryFunctions: queries.reduce((a, q) => a + q.functions.length, 0),
      models: models.length,
      enums: enums.length,
      scheduledJobs: scheduledJobs.length,
      featureFlags: Object.keys(FEATURES).length,
    },
    modules,
    rbacActions: ACTIONS,
    roles,
    navigation: NAVIGATION,
    pages,
    apiRoutes,
    actions,
    queries,
    models,
    enums,
    scheduledJobs,
    featureFlags: Object.values(FEATURES).map((f) => ({ key: f.key, label: f.label, description: f.description })),
    workflowFiles: walk("src/lib/workflow", (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")),
  };
}

const esc = (s: string | null | undefined): string => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function markdown(map: ErpMap): string {
  const L: string[] = [];
  L.push("# ERP_AUDIT — cartographie de AMD Internal OS");
  L.push("");
  L.push("> **Généré** par `npx tsx scripts/erp-audit/run.ts` — ne pas modifier à la main.");
  L.push("> Toute ligne de ce document est lue dans le code : schéma Prisma, matrice RBAC, arbre");
  L.push("> des pages, actions serveur, routes API, planificateur, drapeaux de version.");
  L.push(`> Dernière génération : ${map.generatedAt}`);
  L.push("");
  L.push("## 0. Volumétrie");
  L.push("");
  L.push("| Élément | Nombre |");
  L.push("|---|---:|");
  for (const [k, v] of Object.entries(map.counts)) L.push(`| ${k} | ${v} |`);
  L.push("");

  L.push("## 1. Modules et permissions");
  L.push("");
  L.push(`Actions RBAC possibles : \`${map.rbacActions.join("`, `")}\`.`);
  L.push("");
  L.push("| Module | Rôles ayant un accès (action → rôles) |");
  L.push("|---|---|");
  for (const m of map.modules) {
    const byAction = new Map<string, string[]>();
    for (const [role, acts] of Object.entries(m.roles)) {
      for (const a of acts) byAction.set(a, [...(byAction.get(a) ?? []), role]);
    }
    const cell = [...byAction.entries()]
      .map(([a, rs]) => `**${a}** : ${rs.length > 8 ? `${rs.length} rôles` : rs.join(", ")}`)
      .join(" · ");
    L.push(`| \`${m.name}\` | ${esc(cell) || "—"} |`);
  }
  L.push("");

  L.push("## 2. Rôles");
  L.push("");
  L.push("| Rôle | Libellé | Modules accessibles |");
  L.push("|---|---|---:|");
  for (const r of map.roles) L.push(`| \`${r.role}\` | ${esc(r.label)} | ${r.modules.length} |`);
  L.push("");

  L.push("## 3. Pages et écrans");
  L.push("");
  L.push("Chaque page déclare le module qu'elle exige à l'entrée (`requireModule`). Une page sans");
  L.push("garde de module est soit publique, soit protégée par une règle plus fine dans son corps.");
  L.push("");
  L.push("| Route | Module exigé | Action | Fichier |");
  L.push("|---|---|---|---|");
  for (const p of [...map.pages].sort((a, b) => a.route.localeCompare(b.route))) {
    L.push(`| \`${p.route}\` | ${p.guardModule ? `\`${p.guardModule}\`` : "—"} | ${p.guardAction ?? "VIEW"} | \`${p.file}\` |`);
  }
  L.push("");

  L.push("## 4. Matrice UI → action → objet → permissions → effets");
  L.push("");
  L.push("La colonne **Action serveur** est le nom exporté réellement appelé par l'écran. C'est");
  L.push("elle que l'API réutilise : il n'existe pas de seconde implémentation de la règle métier.");
  L.push("");
  L.push("| Action serveur | Fichier | Modules exigés | Actions RBAC | Accès ligne | Écrit | Audité | Notifie | Fichiers | Objet / effet |");
  L.push("|---|---|---|---|:-:|:-:|:-:|:-:|:-:|---|");
  const yn = (b: boolean): string => (b ? "✔" : "");
  for (const a of [...map.actions].sort((x, y) => x.file.localeCompare(y.file) || x.name.localeCompare(y.name))) {
    L.push(
      `| \`${a.name}\` | \`${a.file.replace("src/lib/actions/", "")}\` | ${a.modules.map((m) => `\`${m}\``).join(", ") || "—"} `
      + `| ${a.rbacActions.join(", ") || "—"} | ${yn(a.entityChecked)} | ${yn(a.writes)} | ${yn(a.audited)} | ${yn(a.notifies)} `
      + `| ${yn(a.files)} | ${esc(a.summary) || "—"} |`,
    );
  }
  L.push("");

  L.push("## 5. Lectures réutilisables (couche requêtes)");
  L.push("");
  L.push("| Module de requêtes | Fonctions exportées |");
  L.push("|---|---|");
  for (const q of map.queries) L.push(`| \`${q.file.replace("src/lib/queries/", "")}\` | ${q.functions.map((f) => `\`${f}\``).join(", ")} |`);
  L.push("");

  L.push("## 6. Routes API existantes (avant ce chantier)");
  L.push("");
  L.push("| Route | Méthodes | Fichier |");
  L.push("|---|---|---|");
  for (const r of [...map.apiRoutes].sort((a, b) => a.route.localeCompare(b.route))) {
    L.push(`| \`${r.route}\` | ${r.methods.join(", ")} | \`${r.file}\` |`);
  }
  L.push("");

  L.push("## 7. Objets métier (modèles)");
  L.push("");
  L.push("| Modèle | Champs | Relations | Description |");
  L.push("|---|---:|---|---|");
  for (const m of [...map.models].sort((a, b) => a.name.localeCompare(b.name))) {
    const rels = m.fields.filter((f) => f.relationTo).map((f) => f.relationTo!);
    L.push(`| \`${m.name}\` | ${m.fields.length} | ${rels.length ? `${rels.length}` : "—"} | ${esc(m.doc) || "—"} |`);
  }
  L.push("");

  L.push("## 8. Statuts et énumérations");
  L.push("");
  L.push("| Énumération | Valeurs |");
  L.push("|---|---|");
  for (const e of [...map.enums].sort((a, b) => a.name.localeCompare(b.name))) {
    L.push(`| \`${e.name}\` | ${e.values.map((v) => `\`${v}\``).join(" · ")} |`);
  }
  L.push("");

  L.push("## 9. Automatisations (planificateur)");
  L.push("");
  L.push("Aucun cron externe : un battement interne (`src/lib/scheduled.ts`) lance ces tâches, au");
  L.push("plus une fois par minute, chacune idempotente.");
  L.push("");
  L.push("| Tâche | Rôle |");
  L.push("|---|---|");
  for (const j of map.scheduledJobs) L.push(`| \`${j.name}\` | ${esc(j.note) || "—"} |`);
  L.push("");

  L.push("## 10. Drapeaux de version (test → production)");
  L.push("");
  L.push("| Clé | Libellé | Description |");
  L.push("|---|---|---|");
  for (const f of map.featureFlags) L.push(`| \`${f.key}\` | ${esc(f.label)} | ${esc(f.description)} |`);
  L.push("");

  L.push("## 11. Moteurs de workflow");
  L.push("");
  for (const f of map.workflowFiles) L.push(`- \`${f}\``);
  L.push("");
  L.push("Voir aussi `src/lib/approval-chain.ts` (chaîne à trois étages Manager → RH → Direction),");
  L.push("`src/lib/regulatory-workflow.ts` (17 étapes + processus ANPP) et `src/modules/rh/infra/leave-core.ts`.");
  L.push("");
  return L.join("\n");
}

const map = build();
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "erp-map.json"), `${JSON.stringify(map, null, 2)}\n`, "utf8");
fs.writeFileSync(path.join(OUT_DIR, "ERP_AUDIT.md"), markdown(map), "utf8");
console.log(`ERP_AUDIT.md + erp-map.json écrits dans docs/api/`);
console.log(Object.entries(map.counts).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
