import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { scopeRegulatory } from "@/lib/rbac";
import { companyScopedWhere } from "@/lib/company";
import {
  REGULATORY_STEP_TYPE, VARIATION_TARGETS, MANUFACTURING_STATUS, VARIATION_STATUS,
  DOSSIER_STEP_KIND, DOSSIER_STEP_ADDABLE,
} from "@/lib/labels";
import { REG_CHECKLIST } from "@/lib/regulatory-workflow";
import {
  createRegulatoryProduct, setRegulatoryParticipants, addRegulatoryComment, updateRegulatoryStep,
  setRegulatoryChecklistItem, createVariation, setVariationStatus, requestBV, setRegulatoryClassification,
} from "@/lib/actions/regulatory-actions";
import { addDossierStep } from "@/lib/actions/regulatory-timeline-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { resolvePeopleList } from "./impl-drive";
import { montantDzd } from "@/lib/utils";

/**
 * OPS REGULATORY — la longue traîne du dossier AMM au-delà des champs simples (déjà natifs) :
 * création de dossier, participants, commentaires, DÉTAIL des étapes de la chronologie,
 * checklist de présoumission, variations de fabrication, BV (ordre de dépense ANPP) et
 * classement (entité / segments). Résolution par RÉFÉRENCE (REG-AAAA-NNN) ou DCI, DANS LE
 * PÉRIMÈTRE de la personne (`scopeRegulatory` + entité courante) ; exécution par les actions
 * canoniques de `regulatory-actions.ts` — verrous structurels (Super Admin) inclus.
 */

export interface ProductHit { id: string; reference: string; dci: string }

export async function resolveRegProduct(user: CurrentUser, raw: string): Promise<ProductHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (REG-AAAA-NNN) ou la DCI du dossier (champ « reference »)." };
  const scope = await companyScopedWhere(user.id, { AND: [scopeRegulatory(user)] });
  const exact = await prisma.regulatoryProduct.findFirst({
    where: { AND: [{ reference: { equals: q, mode: "insensitive" } }, scope] },
    select: { id: true, reference: true, dci: true },
  });
  if (exact) return exact;
  const rows = await prisma.regulatoryProduct.findMany({
    where: { AND: [{ OR: [{ reference: { contains: q, mode: "insensitive" } }, { dci: { contains: q, mode: "insensitive" } }, { brandName: { contains: q, mode: "insensitive" } }] }, scope] },
    select: { id: true, reference: true, dci: true },
    orderBy: { updatedAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucun dossier « ${q} » dans votre périmètre (search_products peut aider).` };
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs dossiers correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.dci}`).join(" ; ")} — donner la référence exacte.` };
}

/** Repli accents/casse pour matcher un LIBELLÉ humain contre un référentiel. */
export const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function matchLabel<T extends string>(raw: string, entries: [T, string][]): T | { error: string } {
  const q = fold(raw);
  if (!q) return { error: "Libellé manquant." };
  const direct = entries.find(([code]) => fold(code) === q);
  if (direct) return direct[0];
  const hits = entries.filter(([, label]) => {
    const l = fold(label);
    return l.includes(q) || q.includes(l) || q.split(" ").every((t) => t.length >= 2 && l.includes(t));
  });
  if (hits.length === 1) return hits[0][0];
  if (hits.length > 1) return { error: `Plusieurs correspondances pour « ${raw} » : ${hits.map(([, l]) => l).join(" ; ")} — préciser.` };
  return { error: `« ${raw} » introuvable. Valeurs possibles : ${entries.map(([, l]) => l).join(" ; ")}.` };
}

const STEP_STATUS_FR: [string, string][] = [
  ["NOT_STARTED", "Non commencé"], ["IN_PROGRESS", "En cours"], ["DONE", "Fait"],
  ["BLOCKED", "Bloqué"], ["LATE", "En retard"],
];

function stepStatusOf(raw: string): string | null {
  const k = fold(raw);
  if (!k) return null;
  if (/non commence|pas commence|not started/.test(k)) return "NOT_STARTED";
  if (/en cours|in progress|demarre/.test(k)) return "IN_PROGRESS";
  if (/fait|termine|done|acheve/.test(k)) return "DONE";
  if (/bloque|blocked/.test(k)) return "BLOCKED";
  if (/retard|late/.test(k)) return "LATE";
  return null;
}

const iso = (raw: string): string | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

function amountOf(input: Record<string, unknown>, key: string): number | null {
  const v = input[key];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const n = Number(s.replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function resolveCompanyByName(raw: string): Promise<{ id: string; name: string } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Nom d'entité manquant." };
  const rows = await prisma.company.findMany({
    where: { name: { contains: q, mode: "insensitive" }, isActive: true },
    select: { id: true, name: true },
    take: 4,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Entité « ${q} » introuvable (ou désactivée).` };
  return { error: `Plusieurs entités correspondent à « ${q} » : ${rows.map((r) => r.name).join(", ")} — préciser.` };
}

async function resolveOnePerson(raw: string, label: string): Promise<{ id: string; name: string } | null | { error: string }> {
  const q = raw.trim();
  if (!q) return null;
  const rows = await prisma.user.findMany({
    where: { name: { contains: q, mode: "insensitive" }, isActive: true },
    select: { id: true, name: true },
    take: 4,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `${label} « ${q} » introuvable dans l'annuaire.` };
  return { error: `Plusieurs « ${q} » pour ${label} : ${rows.map((r) => r.name).join(", ")} — préciser.` };
}

const productLink = (id: string): string => `/regulatory/${id}`;
const REG_REVALIDATE = ["/regulatory"];

const CHECKLIST_ENTRIES: [string, string][] = REG_CHECKLIST.flatMap((g) => g.items.map((i) => [i.key, i.label] as [string, string]));

/** Les étapes qu'on peut AJOUTER à la frise, avec leurs mots — le même vocabulaire que l'écran
 *  du dossier et que le journal d'audit (`DOSSIER_STEP_*`, `lib/labels.ts`). Les RÈGLES, elles,
 *  restent côté action : Adam propose, `addDossierStep` valide et refuse. */
const DOSSIER_STEP_ENTRIES: [string, string][] = DOSSIER_STEP_ADDABLE.map((k) => [k, DOSSIER_STEP_KIND[k]]);

export const REGULATORY_OPS_IMPL: Record<string, OpImpl> = {
  create_product: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dci = opStr(input, "dci");
      if (!dci) return { error: "La DCI est obligatoire (champ « dci »)." };
      const entity = opStr(input, "entity");
      if (!entity) return { error: "L'ENTITÉ est obligatoire (champ « entity ») : elle décide qui verra le dossier." };
      const company = await resolveCompanyByName(entity);
      if ("error" in company) return company;
      const responsible = await resolveOnePerson(opStr(input, "responsibleName"), "Le responsable");
      if (responsible && "error" in responsible) return responsible;
      const brandName = opStr(input, "brandName");
      const form = opStr(input, "form");
      const dosage = opStr(input, "dosage");
      const partnerLab = opStr(input, "partnerLab");
      const targetSubmissionDate = iso(opStr(input, "targetSubmissionDate"));
      return {
        title: `Créer le dossier réglementaire ${dci.toUpperCase()}`,
        fields: [
          { label: "DCI", value: dci.toUpperCase() },
          { label: "Entité", value: company.name },
          ...(brandName ? [{ label: "Nom de marque", value: brandName }] : []),
          ...(form ? [{ label: "Forme", value: form }] : []),
          ...(dosage ? [{ label: "Dosage", value: dosage }] : []),
          ...(partnerLab ? [{ label: "Partenaire", value: partnerLab }] : []),
          ...(responsible ? [{ label: "Chargé du dossier", value: responsible.name }] : []),
          ...(targetSubmissionDate ? [{ label: "Dépôt cible", value: targetSubmissionDate }] : []),
          { label: "Référence", value: "générée automatiquement (REG-AAAA-NNN)" },
        ],
        warnings: ["Le dossier naît AU PIPELINE (verrouillé, à l'étude) avec ses 17 étapes : un dossier du suivi exige sa CTD initiale, que l'assistant ne peut pas joindre — elle se joint à l'ouverture du cadenas."],
        args: {
          dci, companyId: company.id, brandName, form, dosage, partnerLab,
          responsibleId: responsible?.id ?? null, targetSubmissionDate,
          comments: opStr(input, "notes"),
        },
        successMessage: `Dossier ${dci.toUpperCase()} créé (${company.name}).`,
        revalidate: REG_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("dci", args.dci ?? "");
      fd.set("companyId", args.companyId ?? "");
      // AU PIPELINE : la CTD initiale, obligatoire dans le suivi (Direction, 06/10), se joint ensuite.
      fd.set("lock", "1");
      if (args.brandName) fd.set("brandName", args.brandName);
      if (args.form) fd.set("pharmaceuticalForm", args.form);
      if (args.dosage) fd.set("dosage", args.dosage);
      if (args.partnerLab) fd.set("partnerLab", args.partnerLab);
      if (args.responsibleId) fd.set("responsibleId", args.responsibleId);
      if (args.targetSubmissionDate) fd.set("targetSubmissionDate", args.targetSubmissionDate);
      if (args.comments) fd.set("comments", args.comments);
      const r = await createRegulatoryProduct(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La création du dossier a été refusée." };
      return { ok: true, createdId: r.id, link: r.id ? productLink(r.id) : "/regulatory", revalidate: REG_REVALIDATE };
    },
  },

  set_participants: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      const rawPeople = opStr(input, "people");
      if (!rawPeople) return { error: "Donnez les participants (champ « people », noms séparés par des virgules)." };
      const { people, problems } = await resolvePeopleList(rawPeople, "");
      if (people.length === 0) return { error: `Aucune personne résolue : ${problems.join(" ; ")}.` };
      return {
        title: `Participants de ${product.reference} : ${people.map((p) => p.name).join(", ")}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Participants", value: people.map((p) => p.name).join(", ") },
        ],
        warnings: [
          "La liste des participants est REMPLACÉE par celle-ci (le responsable et l'assistant du dossier gardent l'accès d'office).",
          ...problems.map((p) => `Ignoré : ${p}.`),
        ],
        args: { id: product.id, userIds: people.map((p) => p.id).join(","), reference: product.reference },
        successMessage: `Participants de ${product.reference} mis à jour (${people.length} personne(s)).`,
        link: productLink(product.id),
        revalidate: REG_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      for (const id of (args.userIds ?? "").split(",").filter(Boolean)) fd.append("participantIds", id);
      const r = await setRegulatoryParticipants(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La mise à jour des participants a été refusée." };
      return { ok: true, revalidate: REG_REVALIDATE };
    },
  },

  add_comment: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const body = opStr(input, "comment");
      if (!body) return { error: "Donnez le commentaire à poster (champ « comment »)." };
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      return {
        title: `Commenter le dossier ${product.reference}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Commentaire", value: body.slice(0, 300) },
        ],
        args: { productId: product.id, body, reference: product.reference },
        successMessage: `Commentaire posté sur ${product.reference}.`,
        link: productLink(product.id),
        revalidate: REG_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("productId", args.productId ?? "");
      fd.set("body", args.body ?? "");
      const r = await addRegulatoryComment(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le commentaire a été refusé." };
      return { ok: true, revalidate: REG_REVALIDATE };
    },
  },

  update_step_details: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      const stepType = matchLabel(opStr(input, "step"), Object.entries(REGULATORY_STEP_TYPE));
      if (typeof stepType === "object") return stepType;
      const step = await prisma.regulatoryStep.findFirst({
        where: { productId: product.id, type: stepType as never },
        select: { id: true, status: true, plannedDate: true, actualDate: true, comment: true, missingDocs: true, responsible: true },
      });
      if (!step) return { error: `L'étape « ${REGULATORY_STEP_TYPE[stepType]} » n'existe pas sur ${product.reference}.` };

      // FUSION : l'action ÉCRASE les champs absents — on rejoue donc l'existant partout où
      // l'utilisateur n'a rien demandé, pour qu'une note ne coûte jamais une date.
      const status = stepStatusOf(opStr(input, "status")) ?? step.status;
      const plannedDate = iso(opStr(input, "plannedDate")) ?? (step.plannedDate ? step.plannedDate.toISOString().slice(0, 10) : null);
      const actualDate = iso(opStr(input, "actualDate")) ?? (step.actualDate ? step.actualDate.toISOString().slice(0, 10) : null);
      const comment = opStr(input, "note") || step.comment || "";
      const missingDocs = opStr(input, "missingDocs") || step.missingDocs || "";
      const responsible = opStr(input, "responsible") || step.responsible || "";
      const statusLabel = STEP_STATUS_FR.find(([c]) => c === status)?.[1] ?? status;
      const changes: string[] = [];
      if (status !== step.status) changes.push(`statut → ${statusLabel}`);
      if (opStr(input, "plannedDate")) changes.push(`date planifiée → ${plannedDate}`);
      if (opStr(input, "actualDate")) changes.push(`date réelle → ${actualDate}`);
      if (opStr(input, "note")) changes.push("note");
      if (opStr(input, "missingDocs")) changes.push("pièces manquantes");
      if (opStr(input, "responsible")) changes.push(`responsable → ${responsible}`);
      if (changes.length === 0) return { error: "Rien à changer : donnez status, plannedDate, actualDate, note, missingDocs ou responsible." };
      return {
        title: `Étape « ${REGULATORY_STEP_TYPE[stepType]} » de ${product.reference}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Étape", value: REGULATORY_STEP_TYPE[stepType] },
          { label: "Modifications", value: changes.join(" · ") },
        ],
        args: { stepId: step.id, status, plannedDate, actualDate, comment, missingDocs, responsible, reference: product.reference },
        successMessage: `Étape « ${REGULATORY_STEP_TYPE[stepType]} » de ${product.reference} mise à jour (${changes.join(", ")}).`,
        link: productLink(product.id),
        revalidate: REG_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("stepId", args.stepId ?? "");
      fd.set("status", args.status ?? "");
      if (args.plannedDate) fd.set("plannedDate", args.plannedDate);
      if (args.actualDate) fd.set("actualDate", args.actualDate);
      if (args.comment) fd.set("comment", args.comment);
      if (args.missingDocs) fd.set("missingDocs", args.missingDocs);
      if (args.responsible) fd.set("responsible", args.responsible);
      const r = await updateRegulatoryStep(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La mise à jour de l'étape a été refusée." };
      return { ok: true, revalidate: REG_REVALIDATE };
    },
  },

  /**
   * AJOUTER UNE ÉTAPE À LA FRISE DU DOSSIER — « note les réserves du 12 mars sur le BICTEGRAVIR ».
   *
   * C'est l'écriture la plus fréquente du module au quotidien : une lettre arrive, une version
   * repart. La faire passer par la conversation évite d'ouvrir la fiche pour trois champs — et
   * l'étape créée est la MÊME que celle du « + » de l'écran, avec le même journal.
   */
  add_dossier_step: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;

      const kind = matchLabel(opStr(input, "kind"), DOSSIER_STEP_ENTRIES);
      if (typeof kind === "object") return kind;

      const versionRaw = opStr(input, "version");
      const version = versionRaw ? Number(versionRaw.replace(/[^0-9]/g, "")) : null;
      if (kind === "CTD_VERSION" && !version) {
        return { error: "Indiquez le numéro de version du CTD (champ « version » : 2, 3, …)." };
      }
      // Sans nom saisi, on n'en INVENTE pas un ici : l'action pose le libellé standard, le même
      // que le « + » de l'écran. Deux endroits qui composent le même nom finiraient par en
      // composer deux.
      const label = opStr(input, "label");
      const occurredAt = iso(opStr(input, "date"));
      const quoi = `${DOSSIER_STEP_KIND[kind]}${version ? ` v${version}` : ""}${label ? ` — ${label}` : ""}`;

      return {
        title: `Frise de ${product.reference} — ${quoi}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Type d'étape", value: DOSSIER_STEP_KIND[kind] },
          ...(label ? [{ label: "Nom", value: label }] : []),
          ...(version ? [{ label: "Version", value: `v${version}` }] : []),
          ...(occurredAt ? [{ label: "Date de l'événement", value: occurredAt }] : []),
        ],
        args: { productId: product.id, kind, label, version: version ? String(version) : null, occurredAt, note: opStr(input, "note"), reference: product.reference },
        successMessage: `Étape ajoutée à la frise de ${product.reference} : ${quoi}.`,
        link: productLink(product.id),
        revalidate: REG_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("productId", args.productId ?? "");
      fd.set("kind", args.kind ?? "");
      fd.set("label", args.label ?? "");
      if (args.version) fd.set("version", args.version);
      if (args.occurredAt) fd.set("occurredAt", args.occurredAt);
      if (args.note) fd.set("note", args.note);
      const r = await addDossierStep(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'ajout à la frise a été refusé." };
      return { ok: true, revalidate: REG_REVALIDATE };
    },
  },

  set_checklist_item: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      const itemKey = matchLabel(opStr(input, "item"), CHECKLIST_ENTRIES);
      if (typeof itemKey === "object") return itemKey;
      const label = CHECKLIST_ENTRIES.find(([k]) => k === itemKey)?.[1] ?? itemKey;
      const checked = !/d[ée]coch|retir|absent|manquant|false|non/i.test(opStr(input, "checked"));
      const note = opStr(input, "note");
      return {
        title: `${checked ? "Cocher" : "Décocher"} « ${label} » — ${product.reference}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Document", value: label },
          { label: "État", value: checked ? "Fourni (coché)" : "Retiré (décoché)" },
          ...(note ? [{ label: "Note", value: note }] : []),
        ],
        args: { productId: product.id, itemKey, checked: checked ? "true" : "false", note, reference: product.reference },
        successMessage: `Checklist de ${product.reference} : « ${label} » ${checked ? "coché" : "décoché"}.`,
        link: productLink(product.id),
        revalidate: REG_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("productId", args.productId ?? "");
      fd.set("itemKey", args.itemKey ?? "");
      fd.set("checked", args.checked ?? "true");
      if (args.note) fd.set("note", args.note);
      const r = await setRegulatoryChecklistItem(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La mise à jour de la checklist a été refusée." };
      return { ok: true, revalidate: REG_REVALIDATE };
    },
  },

  create_variation: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      const target = matchLabel(opStr(input, "target"), VARIATION_TARGETS.map((t) => [t, MANUFACTURING_STATUS[t] ?? t] as [string, string]));
      if (typeof target === "object") return target;
      const manufacturer = opStr(input, "manufacturer");
      const depotDate = iso(opStr(input, "date"));
      return {
        title: `Déposer une variation → ${MANUFACTURING_STATUS[target]} sur ${product.reference}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Cible", value: MANUFACTURING_STATUS[target] },
          ...(manufacturer ? [{ label: "Fabricant", value: manufacturer }] : []),
          ...(depotDate ? [{ label: "Dépôt le", value: depotDate }] : []),
        ],
        warnings: ["La variation naît EN ATTENTE — le statut de fabrication du produit ne bouge qu'à l'obtention (Super Admin)."],
        args: { productId: product.id, toStatus: target, manufacturer, depotDate, note: opStr(input, "note"), reference: product.reference },
        successMessage: `Variation → ${MANUFACTURING_STATUS[target]} déposée sur ${product.reference}.`,
        link: productLink(product.id),
        revalidate: REG_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("productId", args.productId ?? "");
      fd.set("toStatus", args.toStatus ?? "");
      if (args.manufacturer) fd.set("manufacturer", args.manufacturer);
      if (args.depotDate) fd.set("depotDate", args.depotDate);
      if (args.note) fd.set("note", args.note);
      const r = await createVariation(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le dépôt de la variation a été refusé." };
      return { ok: true, revalidate: REG_REVALIDATE };
    },
  },

  set_variation_status: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      const rawStatus = fold(opStr(input, "status"));
      const status = /obtenu/.test(rawStatus) ? "OBTENUE" : /annul/.test(rawStatus) ? "ANNULE" : /attente/.test(rawStatus) ? "EN_ATTENTE" : null;
      if (!status) return { error: "Précisez le statut : obtenue, en attente ou annulée (champ « status »)." };
      const variations = await prisma.regulatoryVariation.findMany({
        where: { productId: product.id },
        select: { id: true, toStatus: true, status: true },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (variations.length === 0) return { error: `Aucune variation sur ${product.reference}.` };
      const open = variations.filter((v) => v.status === "EN_ATTENTE");
      const pick = variations.length === 1 ? variations[0] : open.length === 1 ? open[0] : null;
      if (!pick) {
        return { error: `Plusieurs variations sur ${product.reference} : ${variations.map((v) => `${MANUFACTURING_STATUS[v.toStatus] ?? v.toStatus} (${VARIATION_STATUS[v.status]?.label ?? v.status})`).join(" ; ")} — préciser la cible.` };
      }
      return {
        title: `Variation ${MANUFACTURING_STATUS[pick.toStatus] ?? pick.toStatus} de ${product.reference} → ${VARIATION_STATUS[status]?.label ?? status}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Variation", value: `${MANUFACTURING_STATUS[pick.toStatus] ?? pick.toStatus} (${VARIATION_STATUS[pick.status]?.label ?? pick.status})` },
          { label: "Nouveau statut", value: VARIATION_STATUS[status]?.label ?? status },
        ],
        warnings: status === "OBTENUE"
          ? ["« OBTENUE » PROMEUT le statut de fabrication du produit — réservé au Super Admin (même verrou que l'écran) ; le chargé du dossier est notifié."]
          : [],
        args: { id: pick.id, status, decisionDate: iso(opStr(input, "date")), reference: product.reference },
        successMessage: `Variation de ${product.reference} → ${VARIATION_STATUS[status]?.label ?? status}.`,
        link: productLink(product.id),
        revalidate: REG_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("status", args.status ?? "");
      if (args.decisionDate) fd.set("decisionDate", args.decisionDate);
      const r = await setVariationStatus(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le changement de statut de la variation a été refusé." };
      return { ok: true, revalidate: REG_REVALIDATE };
    },
  },

  request_bv: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      const amount = amountOf(input, "amount");
      if (amount === null || amount <= 0) return { error: "Donnez le montant du BV en DZD (champ « amount »)." };
      const bvType = opStr(input, "bvType") || "BV";
      const dueDate = iso(opStr(input, "dueDate"));
      return {
        title: `Demander un ${bvType} — ${product.reference} (${montantDzd(amount)})`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Type", value: bvType },
          { label: "Montant", value: montantDzd(amount) },
          ...(dueDate ? [{ label: "Échéance", value: dueDate }] : []),
        ],
        warnings: ["Un ORDRE DE DÉPENSE (bénéficiaire ANPP) est créé dans le circuit Finances / Centre de paiement — rien n'est décaissé ici."],
        args: { productId: product.id, bvType, amount: String(amount), dueDate, note: opStr(input, "note"), reference: product.reference },
        successMessage: `${bvType} demandé sur ${product.reference} — ordre de dépense de ${montantDzd(amount)} créé.`,
        link: productLink(product.id),
        revalidate: [...REG_REVALIDATE, "/finances"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("productId", args.productId ?? "");
      fd.set("bvType", args.bvType ?? "BV");
      fd.set("amount", args.amount ?? "");
      if (args.dueDate) fd.set("dueDate", args.dueDate);
      if (args.note) fd.set("note", args.note);
      const r = await requestBV(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La demande de BV a été refusée." };
      return { ok: true, revalidate: [...REG_REVALIDATE, "/finances"] };
    },
  },

  set_classification: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      const entity = opStr(input, "entity");
      const segmentsRaw = opStr(input, "segments");
      const projetRaw = opStr(input, "project");
      if (!entity && !segmentsRaw && !projetRaw) {
        return { error: "Donnez l'entité (champ « entity »), les segments thérapeutiques (champ « segments », séparés par des virgules) et/ou le projet BD (champ « project » ; « aucun » pour le retirer)." };
      }
      let company: { id: string; name: string } | null = null;
      if (entity) {
        const c = await resolveCompanyByName(entity);
        if ("error" in c) return c;
        company = c;
      }
      // ── LE PROJET BD ─────────────────────────────────────────────────────────────────────
      //
      // On ne DEVINE jamais : un seul projet correspondant est retenu, PLUSIEURS n'en désignent
      // aucun et le refus les nomme — choisir à la place d'un humain rangerait le dossier dans
      // le mauvais projet en annonçant que c'est fait (§118.34). « Aucun » / « sans projet »
      // RETIRE le classement, et c'est un geste voulu, distinct de « ne pas y toucher ».
      let projet: { id: string; name: string } | null | "RETIRER" = null;
      if (projetRaw) {
        const q = projetRaw.trim().toLowerCase();
        if (["aucun", "aucune", "sans projet", "rien", "null", "-"].includes(q)) projet = "RETIRER";
        else {
          const tous = await prisma.bdProject.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
          const exact = tous.filter((pr) => pr.name.toLowerCase() === q);
          const partiels = tous.filter((pr) => pr.name.toLowerCase().includes(q));
          const retenus = exact.length > 0 ? exact : partiels;
          if (retenus.length === 0) {
            return { error: `Aucun projet ne correspond à « ${projetRaw} ». Projets existants : ${tous.map((pr) => pr.name).join(", ") || "aucun"}. Les projets se créent dans Business Development › Projets.` };
          }
          if (retenus.length > 1) {
            return { error: `Plusieurs projets correspondent à « ${projetRaw} » : ${retenus.map((pr) => pr.name).join(", ")}. Précisez lequel.` };
          }
          projet = retenus[0]!;
        }
      }
      const segments = segmentsRaw ? segmentsRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : null;
      return {
        title: `Classement de ${product.reference}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          ...(company ? [{ label: "Entité", value: company.name }] : []),
          ...(segments ? [{ label: "Segments", value: segments.join(", ") }] : []),
          ...(projet ? [{ label: "Projet BD", value: projet === "RETIRER" ? "— retiré —" : projet.name }] : []),
        ],
        warnings: [
          ...(company ? ["Changer l'ENTITÉ déplace le dossier d'une société à l'autre — réservé au Super Admin (même règle que l'écran)."] : []),
          ...(segments ? ["La liste des segments est REMPLACÉE ; un segment hors référentiel est ignoré (liste blanche de l'Administration)."] : []),
        ],
        args: {
          id: product.id, companyId: company?.id ?? null,
          segments: segments ? segments.join(",") : null,
          // Chaîne VIDE = « retirer », absent = « ne pas y toucher » : le serveur lit `has`.
          bdProjectId: projet === "RETIRER" ? "" : (projet?.id ?? null),
          reference: product.reference,
        },
        successMessage: `Classement de ${product.reference} mis à jour.`,
        link: productLink(product.id),
        revalidate: REG_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      if (args.companyId) fd.set("companyId", args.companyId);
      if (args.segments !== null && args.segments !== undefined) {
        for (const s of (args.segments ?? "").split(",").filter(Boolean)) fd.append("segments", s);
      }
      if (args.bdProjectId !== null && args.bdProjectId !== undefined) fd.set("bdProjectId", args.bdProjectId);
      const r = await setRegulatoryClassification(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le classement a été refusé." };
      return { ok: true, revalidate: REG_REVALIDATE };
    },
  },
};
