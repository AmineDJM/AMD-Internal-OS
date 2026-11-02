/**
 * `npm run capacites:inventaire` — L'INVENTAIRE « AVANT J6 → APRÈS » (décision 0020) : aucune régression de capacité.
 *
 * Avant J6, l'Assistant IA empruntait à Adam neuf écritures et cinq outils de domaine (`regulatory_/hr_/task_/drive_/
 * request_operation`, 114 ops du catalogue `OPS_CATALOG`). Chacun a ici son ÉQUIVALENT d'après (une capacité dérivée
 * d'une action d'écran, ou un outil propre au module) ; le script vérifie que l'équivalent existe, qu'il est APPELABLE,
 * et que sa porte s'ouvre à CHAQUE rôle que la porte d'Adam laissait passer (droits par défaut du rôle). Il écrit :
 *
 *   • `src/modules/assistant-ia/infra/equivalents-avant-j6.json` — l'instantané figé, que `equivalents-avant-j6.test.ts` rejoue
 *     à chaque `npm test` (le module n'importe pas Adam : l'instantané est la seule mémoire du « avant ») ;
 *   • `docs/assistant/decisions/0020-inventaire.md` — le tableau joint à la décision.
 *
 * Sort en échec s'il reste un trou. Script de lot : il lit Adam (côté `scripts/`), jamais l'inverse.
 *
 *   DATABASE_URL=postgresql://amd:amd@localhost:5432/amd_internal_os npm run capacites:inventaire
 */
import fs from "node:fs";
import { OPS_CATALOG } from "@/lib/assistant/ops/catalog";
import { ROLE_LABELS } from "@/lib/labels";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { porteOuverte, registreDesCapacites } from "@/modules/assistant-ia/api";

const DOMAINES = ["regulatory_operation", "hr_operation", "task_operation", "drive_operation", "request_operation"];
const SORTIE_JSON = "src/modules/assistant-ia/infra/equivalents-avant-j6.json";
const SORTIE_MD = "docs/assistant/decisions/0020-inventaire.md";

/** Là où le `covers` d'Adam ne dit pas l'équivalent d'après (action refusée au générique, ou geste repris autrement). */
const RELAIS: Record<string, string[]> = {
  "task_operation:refuse": ["task-actions:respondTaskRequest"],
  "hr_operation:create_employee": ["hr-actions:createEmployee"],
  "hr_operation:update_employee": ["hr-actions:updateEmployee"],
  "hr_operation:update_employee_salary": ["hr-actions:updateEmployee"],
  "request_operation:edit_own_request": ["admin-request-actions:corrigerMaDemande"],
  "task_operation:set_custom_field": ["custom-field-actions:modifierChampPersonnalise"],
  "task_operation:upload_document": ["outil:preparer_depot_piece"],
};
/** Les écritures empruntées hors des outils de domaine (`buildProposal` / `performAction`). */
/** `tous` : offerte avant J6 à chaque personne (l'espace de travail, la messagerie, les demandes RH et administratives). */
const ECRITURES: Record<string, { libelle: string; apres: string[]; tous?: true }> = {
  create_task: { libelle: "Créer une tâche", apres: ["task-actions:createTask"], tous: true },
  update_task: { libelle: "Modifier une tâche (échéance, priorité, responsable, statut, commentaire)", apres: ["task-actions:modifierTache", "task-actions:updateTaskStatus", "task-actions:addTaskComment"], tous: true },
  send_message: { libelle: "Écrire à une personne", apres: ["outil:send_message"] },
  create_hr_request: { libelle: "Demander un document RH", apres: ["hr-document-actions:requestHrDocument"], tous: true },
  create_admin_request: { libelle: "Demande administrative", apres: ["admin-request-actions:createRequest"], tous: true },
  update_regulatory_product: { libelle: "Modifier un dossier réglementaire", apres: ["regulatory-actions:updateRegulatoryProduct", "regulatory-actions:updateRegulatoryStatus", "regulatory-actions:setRegulatoryPriority", "regulatory-actions:setRegulatoryTargetDates", "regulatory-actions:setRegulatoryLock"] },
  assign_regulatory_responsible: { libelle: "Désigner le responsable d'un dossier", apres: ["regulatory-actions:setRegulatoryResponsible"] },
  set_regulatory_step: { libelle: "Régler une étape réglementaire", apres: ["regulatory-actions:setRegulatoryStepState", "regulatory-actions:setRegulatoryPresubOutcome"] },
  request_regulatory_status_update: { libelle: "Demander un point de statut", apres: ["regulatory-actions:requestRegulatoryStatusUpdate"] },
};
/**
 * Les rôles que la porte d'Adam laissait passer mais que l'ACTION refuse de toute façon : la porte d'Adam était plus
 * large que le geste (« revérifié par l'action »). Ce n'est pas une capacité perdue — nommé ici, avec la raison.
 */
const PORTE_ADAM_PLUS_LARGE_QUE_L_ACTION: Record<string, string> = {
  "drive_operation:update_letterhead": "papier à en-tête : l'action le réserve à l'assistante de direction et à la direction artistique",
  "drive_operation:delete_letterhead": "papier à en-tête : l'action le réserve à l'assistante de direction et à la direction artistique",
};

interface Ligne { avant: string; libelle: string; apres: string[]; roles: string[]; note?: string }

async function main(): Promise<void> {
  const reg = registreDesCapacites();
  const roles = (Object.keys(ROLE_LABELS) as CurrentUser["role"][]).filter((r) => r !== "SUPER_ADMIN");
  const comptes = await Promise.all(roles.map(async (role) => ({
    role, access: await getAccess(`__inventaire_${role}`, role),
  })));
  const utilisateurs = comptes.map(({ role, access }) => ({ id: `__inventaire_${role}`, name: role, email: "", role, secondaryRole: null, access, mustChangePassword: false }) as unknown as CurrentUser);

  const lignes: Ligne[] = [];
  for (const m of OPS_CATALOG.filter((o) => DOMAINES.includes(o.tool))) {
    const cle = `${m.tool}:${m.op}`;
    const exception = PORTE_ADAM_PLUS_LARGE_QUE_L_ACTION[cle];
    lignes.push({
      avant: `${m.tool}.${m.op}`, libelle: m.uiLabel, apres: RELAIS[cle] ?? m.covers,
      roles: exception ? [] : utilisateurs.filter((u) => m.gate(u)).map((u) => u.role), ...(exception ? { note: exception } : {}),
    });
  }
  for (const [nom, e] of Object.entries(ECRITURES)) lignes.push({ avant: nom, libelle: e.libelle, apres: e.apres, roles: e.tous ? roles : [] });

  const trous: string[] = [];
  for (const l of lignes) {
    const caps = l.apres.filter((k) => !k.startsWith("outil:")).map((k) => ({ k, c: reg.parId.get(k) }));
    for (const { k, c } of caps) if (!c?.appelable) trous.push(`${l.avant} → ${k} : ${c ? c.refus : "absente"}`);
    if (!caps.length) continue;
    for (const role of l.roles) {
      const u = utilisateurs.find((x) => x.role === role)!;
      if (!caps.some(({ c }) => c && porteOuverte(u, c))) trous.push(`${l.avant} : porte fermée au rôle ${role}`);
    }
  }
  if (trous.length) {
    console.error(`${trous.length} trou(s) :\n${trous.join("\n")}`);
    process.exit(1);
  }

  const json = Object.fromEntries(lignes.map((l) => [l.avant, { libelle: l.libelle, apres: l.apres, roles: l.roles }]));
  fs.writeFileSync(SORTIE_JSON, `${JSON.stringify(json, null, 1)}\n`);
  const cellule = (k: string) => {
    if (k.startsWith("outil:")) return `\`${k.slice(6)}\` (outil propre)`;
    const c = reg.parId.get(k)!;
    return `\`${c.outil}\` ${c.risque}`;
  };
  const md = [
    "# 0020 — Inventaire « avant J6 → après » (généré par `npm run capacites:inventaire`, ne pas éditer)",
    "",
    `${lignes.length} gestes que l'Assistant IA offrait avant J6 par Adam (${lignes.length - Object.keys(ECRITURES).length} ops des cinq outils de domaine, ${Object.keys(ECRITURES).length} écritures) :`,
    "chacun a son équivalent APPELABLE, ouvert à chaque rôle que la porte d'Adam laissait passer (droits par défaut du rôle).",
    "Les lectures empruntées et les outils propres au module figurent dans la décision (§ 4, § 8).",
    "",
    "| Avant (Adam) | Geste | Après (capacité · risque, ou outil propre) | Rôles vérifiés |",
    "|---|---|---|---|",
    ...lignes.map((l) => `| \`${l.avant}\` | ${l.libelle} | ${l.apres.map(cellule).join(", ")} | ${l.note ? `— ${l.note}` : l.roles.length ? l.roles.length : "porte de l'action"} |`),
    "",
  ].join("\n");
  fs.writeFileSync(SORTIE_MD, md);
  console.log(`${lignes.length} gestes, 0 trou → ${SORTIE_JSON}, ${SORTIE_MD}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
