import { prisma } from "@/lib/prisma";
import { MODULES, PERMISSIONS, can, hasGlobalView, anyRoleFilter, type Module } from "@/lib/rbac";
import { NAVIGATION, ROLE_LABELS } from "@/lib/labels";
import { validateUpload, validateDriveUpload, validateDocumentUpload } from "@/lib/storage";
import { aiConfigured, sttConfigured, aiModel, cleModeleRequise } from "@/lib/ai";
import type { UserRole } from "@prisma/client";

/**
 * Diagnostic de plateforme — « le médecin d'Adventum OS ». Lecture seule, calculé à la
 * volée (aucune donnée simulée) : on sonde le fonctionnement RÉEL (base, IA, stockage,
 * rôles, files d'attente, formats acceptés) et la cohérence structurelle (navigation ↔
 * RBAC), on en tire des **constats** classés, puis (côté IA) des **idées** concrètes.
 *
 * Robuste : chaque sonde est isolée — une sonde qui échoue n'empêche pas les autres.
 */

export type Severity = "critical" | "warning" | "info" | "ok";
export interface Finding {
  severity: Severity;
  area: string; // domaine (Base, Rôles, Files, Formats, Navigation, IA, Environnement…)
  title: string;
  detail: string;
  suggestion?: string;
}

export interface HealthProbe { key: string; label: string; ok: boolean; value: string }
export interface UploadSurface { key: string; label: string; strategy: "allowlist" | "blocklist"; maxMb: number; accepted: string[]; rejected: string[] }
export interface RoleCoverage { role: UserRole; label: string; active: number; critical: boolean; impact: string }
export interface ModuleStat { key: string; label: string; count: number }

/** Repères d'ergonomie / structure / performance — nourrissent le jury de design IA. */
export interface DesignSignals {
  menuTopLevel: number; // entrées de menu de 1er niveau
  menuTotal: number; // entrées + onglets
  roleCount: number;
  roleModules: { min: number; max: number; avg: number };
  redundantRoleGroups: string[][]; // rôles au périmètre de VUE identique
  uploadPolicies: number; // nombre de politiques d'upload distinctes
  sampleQueryMs: number; // temps d'une requête représentative (proxy « temps de réponse »)
}

export interface PlatformDiagnostic {
  generatedAt: string;
  healthScore: number; // 0-100
  probes: HealthProbe[];
  findings: Finding[];
  uploads: UploadSurface[];
  roles: RoleCoverage[];
  moduleStats: ModuleStat[];
  rbac: { role: string; label: string; globalView: boolean; modules: number }[];
  design: DesignSignals;
  counts: { pages: number; roles: number; modules: number };
}

const DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 21; // au-delà, une demande en attente est « bloquée »

// Panel de formats testés contre chaque surface d'upload (réels, courants en pharma).
const FORMAT_PANEL = [
  "pdf", "docx", "xlsx", "pptx", "png", "jpg", "svg", "heic",
  "mp4", "mov", "zip", "dwg", "xml", "eml", "msg", "odt", "rtf", "txt", "csv", "json",
];

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

// ───────────────────────────── Sondes ─────────────────────────────

async function probeDatabase(): Promise<{ probe: HealthProbe; findings: Finding[] }> {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const ms = Date.now() - t0;
    const findings: Finding[] = ms > 800
      ? [{ severity: "warning", area: "Base", title: "Base de données lente", detail: `La requête témoin a mis ${ms} ms.`, suggestion: "Vérifier la charge / les index / le plan de l'hébergeur." }]
      : [];
    return { probe: { key: "db", label: "Base de données", ok: true, value: `OK · ${ms} ms` }, findings };
  } catch (e) {
    return {
      probe: { key: "db", label: "Base de données", ok: false, value: "Injoignable" },
      findings: [{ severity: "critical", area: "Base", title: "Base de données injoignable", detail: String((e as Error).message).slice(0, 200), suggestion: "Vérifier DATABASE_URL et l'état du serveur Postgres." }],
    };
  }
}

function probeUploads(): { uploads: UploadSurface[]; findings: Finding[] } {
  const maxDoc = Number(process.env.MAX_UPLOAD_MB ?? "25");
  const maxDrive = Number(process.env.MAX_DRIVE_UPLOAD_MB ?? process.env.MAX_UPLOAD_MB ?? "100");
  const surfaces: { key: string; label: string; strategy: "allowlist" | "blocklist"; maxMb: number; fn: (n: string, s: number) => string | null }[] = [
    { key: "biz", label: "Pièces jointes métier (rapports terrain, sponsoring, congrès, RH…)", strategy: "blocklist", maxMb: maxDoc, fn: (n, s) => validateUpload(n, s, maxDoc) },
    { key: "documents", label: "Documents (dossiers, factures, CTD…)", strategy: "blocklist", maxMb: maxDoc, fn: (n, s) => validateDocumentUpload(n, s, maxDoc) },
    { key: "drive", label: "Drive (fichiers)", strategy: "blocklist", maxMb: maxDrive, fn: (n, s) => validateDriveUpload(n, s, maxDrive) },
  ];
  const uploads: UploadSurface[] = surfaces.map((sf) => {
    const accepted: string[] = [], rejected: string[] = [];
    for (const ext of FORMAT_PANEL) (sf.fn(`test.${ext}`, 1024) === null ? accepted : rejected).push(ext);
    return { key: sf.key, label: sf.label, strategy: sf.strategy, maxMb: sf.maxMb, accepted, rejected };
  });

  const findings: Finding[] = [];
  const biz = uploads.find((u) => u.key === "biz");
  // Formats courants qu'on aurait de bonnes raisons d'accepter dans les pièces jointes métier.
  const wanted = ["svg", "heic", "mp4", "mov", "odt", "rtf", "dwg", "xml", "eml", "msg"];
  const missing = biz ? wanted.filter((f) => biz.rejected.includes(f)) : [];
  if (missing.length) {
    findings.push({
      severity: "warning", area: "Formats",
      title: "Certains espaces refusent des formats de fichiers courants",
      detail: `Les pièces jointes métier refusent : ${missing.map((m) => "." + m).join(", ")}. Un utilisateur ne peut pas y déposer ces fichiers.`,
      suggestion: "Élargir ALLOWED_EXTENSIONS dans src/lib/storage.ts (ou aligner sur la stratégie « blocklist » du Drive/Documents qui n'interdit que les exécutables).",
    });
  }
  return { uploads, findings };
}

async function probeRoles(): Promise<{ roles: RoleCoverage[]; findings: Finding[] }> {
  const CRIT: { role: UserRole; critical: boolean; impact: string }[] = [
    { role: "SUPER_ADMIN", critical: true, impact: "Sans Super Admin actif, l'administration et le pilotage sont inaccessibles." },
    { role: "DIRECTION", critical: true, impact: "La Direction valide les demandes Ad & Pro et les ordres de dépense." },
    { role: "NATIONAL_SALES", critical: false, impact: "Approbation préliminaire Ad & Pro : sans lui, les demandes de délégués restent bloquées à l'étape préliminaire." },
    { role: "PRODUCT_MANAGER", critical: false, impact: "Analyse (Direction Marketing) des demandes Ad & Pro." },
    { role: "MEDICAL_INFO_PHARMACIST", critical: false, impact: "Émission des déclarations d'information médicale (PRIM) ; sinon repli en ordre de dépense direct." },
    { role: "FINANCE_BUDGET_MANAGER", critical: false, impact: "Règlement des ordres de dépense : sans lui, rien n'est réglé côté Finances." },
    { role: "DIRECTION_ASSISTANT", critical: false, impact: "Pilote le Bureau du secrétariat et le matériel promotionnel." },
  ];
  const roles: RoleCoverage[] = [];
  const findings: Finding[] = [];
  for (const c of CRIT) {
    const active = await safe(() => prisma.user.count({ where: { isActive: true, ...anyRoleFilter([c.role]) } }), -1);
    roles.push({ role: c.role, label: ROLE_LABELS[c.role] ?? c.role, active: Math.max(active, 0), critical: c.critical, impact: c.impact });
    if (active === 0) {
      findings.push({
        severity: c.critical ? "critical" : "warning", area: "Rôles",
        title: `Aucun compte actif « ${ROLE_LABELS[c.role] ?? c.role} »`,
        detail: c.impact,
        suggestion: `Créer ou activer au moins un compte avec le rôle ${ROLE_LABELS[c.role] ?? c.role} (principal ou secondaire).`,
      });
    }
  }
  return { roles, findings };
}

async function probeAccounts(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const neverLogged = await safe(() => prisma.user.count({ where: { isActive: true, mustChangePassword: true } }), 0);
  if (neverLogged > 0) {
    findings.push({ severity: "info", area: "Comptes", title: `${neverLogged} compte(s) jamais activé(s)`, detail: "Ces comptes doivent encore changer leur mot de passe (jamais connectés).", suggestion: "Relancer ces utilisateurs ou désactiver les comptes inutiles." });
  }
  return findings;
}

async function probeStuck(): Promise<Finding[]> {
  const cutoff = new Date(Date.now() - STALE_DAYS * DAY);
  const findings: Finding[] = [];
  const wf = await safe(() => prisma.workflowInstance.count({ where: { status: "IN_PROGRESS", createdAt: { lt: cutoff } } }), 0);
  if (wf > 0) findings.push({ severity: "warning", area: "Files d'attente", title: `${wf} circuit(s) Ad & Pro en attente depuis > ${STALE_DAYS} j`, detail: "Des demandes de sponsoring / congrès / événement stagnent dans le circuit de validation.", suggestion: "Relancer les validateurs concernés (Mon travail) ou revoir le circuit dans Administration → Circuits de validation." });
  // UN PAIEMENT REPORTÉ N'EST PAS UN PAIEMENT OUBLIÉ : la date a été posée exprès, avec un motif.
  // Le compter comme « en souffrance » remplirait l'audit d'alertes qu'on a soi-même créées, et
  // c'est ainsi qu'on cesse de lire un audit. Un report ÉCHU, lui, revient dans le compte : sa
  // date est passée, l'ordre est de nouveau dû.
  const eo = await safe(() => prisma.expenseOrder.count({
    where: {
      status: { in: ["PENDING", "REVISION_REQUESTED"] },
      createdAt: { lt: cutoff },
      OR: [{ deferredUntil: null }, { deferredUntil: { lte: new Date() } }],
    },
  }), 0);
  if (eo > 0) findings.push({ severity: "warning", area: "Files d'attente", title: `${eo} ordre(s) de dépense non réglé(s) depuis > ${STALE_DAYS} j`, detail: "Des ordres de dépense attendent d'être exécutés par les Finances.", suggestion: "Vérifier la disponibilité budgétaire et relancer le règlement côté Finances." });
  const vr = await safe(() => prisma.validationRequest.count({ where: { status: "PENDING", createdAt: { lt: cutoff } } }), 0);
  if (vr > 0) findings.push({ severity: "warning", area: "Files d'attente", title: `${vr} demande(s) de validation en attente depuis > ${STALE_DAYS} j`, detail: "Des demandes du bureau de validation n'ont pas été traitées.", suggestion: "Relancer les validateurs ou clôturer les demandes obsolètes." });
  return findings;
}

function probeAi(): { probes: HealthProbe[]; findings: Finding[] } {
  const ai = aiConfigured();
  const stt = sttConfigured();
  const probes: HealthProbe[] = [
    { key: "ai", label: "IA (Claude)", ok: ai, value: ai ? `Active · ${aiModel()}` : "Désactivée" },
    { key: "stt", label: "Transcription vocale", ok: stt, value: stt ? "Active" : "Désactivée" },
  ];
  const findings: Finding[] = [];
  if (!ai) {
    // La clé à poser suit le fournisseur ACTIF du registre (§118.128) : nommer celle d'un autre
    // fournisseur ferait ajouter une variable qui ne change rien.
    const cle = cleModeleRequise();
    findings.push({ severity: "warning", area: "IA", title: "IA désactivée", detail: `${cle} absente : chatbot, analyses et ce diagnostic (partie idées) sont indisponibles.`, suggestion: `Ajouter ${cle} dans les variables d'environnement (Render).` });
  }
  return { probes, findings };
}

function probeEnv(): { probes: HealthProbe[]; findings: Finding[] } {
  const push = Boolean(process.env.VAPID_PRIVATE_KEY && (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY));
  const probes: HealthProbe[] = [
    { key: "storage", label: "Stockage fichiers", ok: true, value: "Base (chiffré, durable)" },
    { key: "push", label: "Notifications push", ok: push, value: push ? "Configurées" : "Non configurées" },
  ];
  const findings: Finding[] = [];
  if (!push) findings.push({ severity: "info", area: "Environnement", title: "Notifications push non configurées", detail: "Les clés VAPID sont absentes : pas de notifications bureau/mobile hors app.", suggestion: "Générer et renseigner les clés VAPID pour activer le Web Push." });
  return { probes, findings };
}

function probeNavCoherence(): Finding[] {
  const findings: Finding[] = [];
  const moduleSet = new Set<string>(MODULES);
  for (const n of NAVIGATION) {
    const targets = [{ label: n.label, module: n.module }, ...(n.tabs ?? []).map((t) => ({ label: `${n.label} › ${t.label}`, module: t.module }))];
    for (const t of targets) {
      if (!moduleSet.has(t.module)) {
        findings.push({ severity: "critical", area: "Navigation", title: `Entrée de menu vers un module inconnu`, detail: `« ${t.label} » référence le module ${t.module}, absent de la matrice RBAC.`, suggestion: "Corriger le module dans src/lib/labels.ts (NAVIGATION)." });
      }
    }
  }
  return findings;
}

async function moduleStats(): Promise<ModuleStat[]> {
  const defs: { key: string; label: string; run: () => Promise<number> }[] = [
    { key: "users", label: "Utilisateurs actifs", run: () => prisma.user.count({ where: { isActive: true } }) },
    { key: "dossiers", label: "Sujets (Pilotage)", run: () => prisma.dossier.count() },
    { key: "regDossiers", label: "Dossiers Regulatory", run: () => prisma.regulatoryDossier.count() },
    { key: "sponsoring", label: "Demandes de sponsoring", run: () => prisma.sponsoringRequest.count() },
    { key: "congressIntl", label: "Prises en charge Internationales", run: () => prisma.congressInternational.count() },
    { key: "events", label: "Événements", run: () => prisma.event.count() },
    { key: "fieldReports", label: "Rapports terrain", run: () => prisma.fieldReport.count() },
    { key: "employees", label: "Employés (RH)", run: () => prisma.employee.count() },
    { key: "budgets", label: "Enveloppes budgétaires", run: () => prisma.budgetEnvelope.count() },
    { key: "expenseOrders", label: "Ordres de dépense", run: () => prisma.expenseOrder.count() },
    { key: "validations", label: "Demandes de validation", run: () => prisma.validationRequest.count() },
    { key: "adminReq", label: "Demandes du secrétariat", run: () => prisma.administrativeRequest.count() },
    { key: "driveNodes", label: "Éléments Drive", run: () => prisma.driveNode.count() },
    { key: "tasks", label: "Tâches", run: () => prisma.task.count() },
    { key: "doctors", label: "Médecins (annuaire)", run: () => prisma.medicalDoctor.count() },
    { key: "meetings", label: "Réunions", run: () => prisma.meeting.count() },
  ];
  const out: ModuleStat[] = [];
  for (const d of defs) out.push({ key: d.key, label: d.label, count: await safe(d.run, -1) });
  return out;
}

// ───────────────────────────── Ergonomie / structure (UX) ─────────────────────────────

/**
 * Repères d'ergonomie inspirés des systèmes de référence (Apple HIG, Microsoft Fluent,
 * Salesforce Lightning) : densité de navigation, clarté des rôles, cohérence des règles.
 */
function probeErgonomics(rbac: PlatformDiagnostic["rbac"], uploads: UploadSurface[]): { design: Omit<DesignSignals, "sampleQueryMs">; findings: Finding[] } {
  const findings: Finding[] = [];
  const menuTopLevel = NAVIGATION.length;
  const menuTotal = NAVIGATION.reduce((n, x) => n + 1 + (x.tabs?.length ?? 0), 0);

  // Densité de menu (loi de Miller ~7±2 ; les apps Lightning regroupent au-delà de ~12 entrées).
  if (menuTopLevel > 14) {
    findings.push({ severity: "info", area: "Ergonomie", title: `Navigation dense (${menuTopLevel} entrées de 1er niveau)`, detail: "Au-delà d'une douzaine d'entrées, la charge cognitive augmente et la barre latérale se sature (réf. Salesforce Lightning app nav, Fluent nav).", suggestion: "Regrouper les modules proches en onglets/sections (comme « Ad & Pro » ou « Mon espace »)." });
  }

  // Rôles au périmètre de VUE identique (ensemble exact de modules) → candidats à simplification.
  const redundant = groupByViewSignature(rbac).filter((g) => g.length > 1);
  if (redundant.length) {
    findings.push({ severity: "info", area: "Rôles", title: `${redundant.length} groupe(s) de rôles au périmètre de vue identique`, detail: `Ex. ${redundant[0].join(", ")} voient exactement les mêmes modules.`, suggestion: "Vérifier s'ils doivent rester distincts (sinon fusionner pour clarifier — principe de simplicité Apple HIG)." });
  }

  // Cohérence des règles d'upload (Apple HIG : « consistency »).
  const policies = new Set(uploads.map((u) => `${u.strategy}:${[...u.accepted].sort().join(",")}`)).size;
  if (policies > 1) {
    findings.push({ severity: "info", area: "Cohérence", title: "Règles de fichiers différentes selon l'espace", detail: `Il existe ${policies} politiques d'upload distinctes : un même utilisateur ne sait pas quels formats passent où (Drive large, pièces jointes strictes…).`, suggestion: "Harmoniser les formats acceptés entre espaces, ou afficher clairement les formats admis dans chaque zone de dépôt." });
  }

  const mods = rbac.filter((r) => !r.globalView).map((r) => r.modules);
  const roleModules = { min: Math.min(...mods, 0), max: Math.max(...mods, 0), avg: mods.length ? Math.round((mods.reduce((a, b) => a + b, 0) / mods.length) * 10) / 10 : 0 };

  return {
    design: { menuTopLevel, menuTotal, roleCount: rbac.length, roleModules, redundantRoleGroups: redundant, uploadPolicies: policies },
    findings,
  };
}

function groupByViewSignature(rbac: PlatformDiagnostic["rbac"]): string[][] {
  const map = new Map<string, string[]>();
  for (const r of rbac) {
    if (r.globalView || r.modules === 0) continue;
    // Signature EXACTE : ensemble des modules visibles (recalculé depuis le rôle).
    const key = MODULES.filter((m) => can(r.role as UserRole, m as Module, "VIEW")).join(",");
    const arr = map.get(key) ?? [];
    arr.push(r.label);
    map.set(key, arr);
  }
  return [...map.values()];
}

async function probeTiming(): Promise<{ probe: HealthProbe; findings: Finding[]; ms: number }> {
  const t0 = Date.now();
  // Requête représentative (jointure + tri) plutôt qu'un simple SELECT 1.
  await safe(() => prisma.user.findMany({ where: { isActive: true }, select: { id: true, role: true }, orderBy: { createdAt: "desc" }, take: 50 }), []);
  const ms = Date.now() - t0;
  const findings: Finding[] = ms > 1200
    ? [{ severity: "warning", area: "Performance", title: "Temps de réponse élevé sur une requête type", detail: `Une requête représentative a mis ${ms} ms — perçu comme lent (au-delà de ~1 s, l'utilisateur décroche).`, suggestion: "Vérifier les index, la taille des tables et la latence réseau de l'hébergeur." }]
    : [];
  return { probe: { key: "latency", label: "Temps de réponse (requête type)", ok: ms <= 1200, value: `${ms} ms` }, findings, ms };
}

function probePharma(): Finding[] {
  const findings: Finding[] = [];
  const navModules = new Set<string>();
  for (const n of NAVIGATION) { navModules.add(n.module); for (const t of n.tabs ?? []) navModules.add(t.module); }
  const needed: [Module, string][] = [["REGULATORY", "Regulatory (dossiers ANPP)"], ["MEDICAL_INFO", "Information médicale (PRIM)"], ["MEDICAL", "Annuaire"], ["PCH", "PCH — marchés publics"]];
  const absent = needed.filter(([m]) => !navModules.has(m));
  if (absent.length) {
    findings.push({ severity: "warning", area: "Pharma", title: "Module pharma clé sans entrée de menu", detail: `Non exposé dans la navigation : ${absent.map((a) => a[1]).join(", ")}.`, suggestion: "Vérifier que ces piliers métier (réglementaire, information médicale) restent accessibles." });
  }
  return findings;
}

// ───────────────────────────── Orchestration ─────────────────────────────

function scoreFrom(findings: Finding[]): number {
  let s = 100;
  for (const f of findings) s -= f.severity === "critical" ? 20 : f.severity === "warning" ? 6 : f.severity === "info" ? 1 : 0;
  return Math.max(0, Math.min(100, s));
}

export async function runDiagnostic(): Promise<PlatformDiagnostic> {
  const [db, uploads, roles, accounts, stuck, stats, timing] = await Promise.all([
    probeDatabase(), Promise.resolve(probeUploads()), probeRoles(), probeAccounts(), probeStuck(), moduleStats(), probeTiming(),
  ]);
  const ai = probeAi();
  const env = probeEnv();
  const nav = probeNavCoherence();

  const rbac = (Object.keys(PERMISSIONS) as UserRole[])
    .map((r) => ({ role: r, label: ROLE_LABELS[r] ?? r, globalView: hasGlobalView(r), modules: hasGlobalView(r) ? MODULES.length : MODULES.filter((m) => can(r, m as Module, "VIEW")).length }));

  const ergo = probeErgonomics(rbac, uploads.uploads);
  const pharma = probePharma();

  const findings: Finding[] = [
    ...db.findings, ...uploads.findings, ...roles.findings, ...accounts, ...stuck, ...ai.findings, ...env.findings, ...nav,
    ...timing.findings, ...ergo.findings, ...pharma,
  ];
  // Tri : critique → avertissement → info.
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    generatedAt: new Date().toISOString(),
    healthScore: scoreFrom(findings),
    probes: [db.probe, timing.probe, ...ai.probes, ...env.probes],
    findings,
    uploads: uploads.uploads,
    roles: roles.roles,
    moduleStats: stats,
    rbac,
    design: { ...ergo.design, sampleQueryMs: timing.ms },
    counts: { pages: NAVIGATION.length, roles: rbac.length, modules: MODULES.length },
  };
}
