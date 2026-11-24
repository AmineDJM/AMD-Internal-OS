import type { EntityType, MailDirection } from "@prisma/client";
import type { Module, SessionUser } from "@/lib/rbac";
import type { Scope } from "@/lib/api/scopes";
import type { ActionResult } from "@/lib/actions/types";
import { createMailEntryFor, updateMailEntryFor, setMailDateFor, type MailFields } from "@/lib/mail-register/write";
import { linkProductToDossierFor, unlinkProductFromDossierFor, type CatalogKind } from "@/lib/products/link";

/**
 * REGISTRE DES OPÉRATIONS — ce qu'un agent a le droit de FAIRE, et rien d'autre.
 *
 * La lecture se déclare par objet (voir `entities.ts`) ; l'écriture, non. Exposer « modifier
 * n'importe quel champ de n'importe quel objet » serait plus simple et gravement faux : un agent
 * pourrait poser un statut sans passer par le circuit qui le justifie, écrire une date de
 * validation sans validation, ou remplir un champ que l'écran calcule. On déclare donc les
 * OPÉRATIONS QUE LE MÉTIER CONNAÎT — « enregistrer un courrier », « poser l'accusé de réception »,
 * « rattacher un produit à son dossier » — chacune avec ses paramètres et sa portée.
 *
 * Trois règles tiennent tout le dispositif :
 *
 *  1. **Une opération n'a pas de chemin privilégié.** Elle appelle le MÊME cœur que l'écran
 *     (`…For(user, …)`), donc les mêmes droits RBAC, le même cloisonnement par entité et le même
 *     journal. Un agent n'a pas de raccourci : il a une autre porte.
 *  2. **L'agent agit AU NOM d'une personne.** C'est la portée de cette personne qui décide, et
 *     jamais celle du client d'API — qui ne peut que la restreindre.
 *  3. **Ce qui n'est pas déclaré n'existe pas.** Aucune opération générique, aucun échappatoire.
 *
 * Ce fichier est un CATALOGUE : ajouter une capacité, c'est ajouter une entrée, pas une route.
 * La liste ci-dessous est un socle — elle grandit opération par opération, chacune adossée à un
 * cœur métier partagé avec l'écran.
 */

export type ParamType = "string" | "number" | "boolean" | "date" | "enum";

export interface ParamDef {
  name: string;
  type: ParamType;
  required?: boolean;
  description: string;
  /** Valeurs admises pour un `enum` — une valeur hors liste est refusée, pas corrigée. */
  values?: readonly string[];
}

export interface OperationDef {
  /** Nom stable, en minuscules, « module.verbe » — c'est l'identifiant public. */
  name: string;
  label: string;
  description: string;
  module: Module;
  /** La portée d'API exigée. Une opération d'écriture ne peut pas se contenter de `erp.read`. */
  scope: Scope;
  params: readonly ParamDef[];
  /** Type d'objet touché — sert au journal d'appels et à la corrélation. */
  entityType?: EntityType;
  /** L'exécution : le MÊME cœur que l'écran, jamais une écriture directe. */
  run: (user: SessionUser, input: Record<string, unknown>) => Promise<ActionResult>;
}

const s = (v: unknown): string | null => {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
};

/**
 * UNE CORRECTION PAR L'API NE PARLE QUE DE CE QU'ELLE ENVOIE (audit Courrier, 24/11).
 *
 * `validateParams` ne rend que les paramètres PRÉSENTS dans l'appel ; on n'en transmet pas d'autres au
 * noyau, qui garde donc tout le reste (`updateMailEntryFor` fusionne). L'ancienne écriture passait
 * chaque champ — `null` pour un absent, `OUTGOING` pour un sens non précisé : corriger le chrono d'un
 * pli entrant effaçait ses dates, son porteur, ses parties, et le retournait en pli sortant.
 *
 * Fonction PURE — testée.
 */
export function correctionDepuisApi(i: Record<string, unknown>): Partial<MailFields> {
  const out: Partial<MailFields> = {};
  const present = (k: string) => Object.prototype.hasOwnProperty.call(i, k);
  if (present("title")) out.title = i.title == null ? "" : String(i.title);
  // Un sens vide ne veut rien dire : la colonne est obligatoire, on n'y touche pas.
  if (present("direction") && s(i.direction)) out.direction = s(i.direction) as MailDirection;
  for (const k of ["reference", "sender", "recipient", "carrier", "notes", "departmentId", "concernedUserId"] as const) {
    if (present(k)) out[k] = s(i[k]);
  }
  for (const k of ["sentAt", "receivedAt", "acknowledgedAt"] as const) {
    const v = i[k];
    if (present(k)) out[k] = v instanceof Date ? v : null;
  }
  // Le nom libre d'une partie remplace le contact d'annuaire : il ne lui correspondrait plus.
  if (present("sender")) out.senderContactId = null;
  if (present("recipient")) out.recipientContactId = null;
  return out;
}

export const OPERATIONS: readonly OperationDef[] = [
  {
    name: "mail.create",
    label: "Enregistrer un courrier",
    description:
      "Inscrit un pli entrant ou sortant au registre. Seul l'objet est obligatoire : l'arrivée et "
      + "l'accusé se posent plus tard, quand ils sont constatés — les exiger ferait inventer une date.",
    module: "MAIL_REGISTER",
    scope: "erp.write",
    entityType: "MAIL_ENTRY",
    params: [
      { name: "title", type: "string", required: true, description: "Objet du courrier." },
      { name: "direction", type: "enum", values: ["INCOMING", "OUTGOING"], description: "Sens du pli (défaut : sortant)." },
      { name: "reference", type: "string", description: "N° de chrono." },
      { name: "sender", type: "string", description: "Expéditeur." },
      { name: "recipient", type: "string", description: "Destinataire." },
      { name: "sentAt", type: "date", description: "Départ (date et heure)." },
      { name: "receivedAt", type: "date", description: "Arrivée." },
      { name: "carrier", type: "string", description: "Porteur (poste, coursier, e-mail…)." },
      { name: "notes", type: "string", description: "Notes." },
      { name: "departmentId", type: "string", description: "Direction (département) concernée par le pli." },
      { name: "concernedUserId", type: "string", description: "Personne nommément concernée par le pli." },
      { name: "sourceType", type: "string", description: "Type de l'objet d'origine (rattachement)." },
      { name: "sourceId", type: "string", description: "Identifiant de l'objet d'origine." },
    ],
    run: (user, i) => createMailEntryFor(user, {
      title: String(i.title ?? ""),
      direction: (s(i.direction) as MailDirection | null) ?? "OUTGOING",
      reference: s(i.reference), sender: s(i.sender), recipient: s(i.recipient),
      sentAt: i.sentAt instanceof Date ? i.sentAt : null,
      receivedAt: i.receivedAt instanceof Date ? i.receivedAt : null,
      carrier: s(i.carrier), notes: s(i.notes),
      departmentId: s(i.departmentId), concernedUserId: s(i.concernedUserId),
      sourceType: (s(i.sourceType) as EntityType | null) ?? null,
      sourceId: s(i.sourceId),
    }),
  },
  {
    name: "mail.update",
    label: "Corriger un courrier",
    description:
      "Met à jour un courrier existant. SEULS LES PARAMÈTRES ENVOYÉS sont modifiés — un paramètre "
      + "absent garde sa valeur ; une valeur vide efface le champ (sauf l'objet, obligatoire, et le "
      + "sens, qui ne s'efface pas). Chaque champ touché part au journal avec son ancienne et sa "
      + "nouvelle valeur : sur un registre qu'on oppose, une correction non tracée ne vaut rien.",
    module: "MAIL_REGISTER",
    scope: "erp.write",
    entityType: "MAIL_ENTRY",
    params: [
      { name: "id", type: "string", required: true, description: "Identifiant du courrier." },
      { name: "title", type: "string", description: "Objet du courrier (absent = inchangé)." },
      { name: "direction", type: "enum", values: ["INCOMING", "OUTGOING"], description: "Sens du pli (absent = inchangé)." },
      { name: "reference", type: "string", description: "N° de chrono." },
      { name: "sender", type: "string", description: "Expéditeur." },
      { name: "recipient", type: "string", description: "Destinataire." },
      { name: "sentAt", type: "date", description: "Départ (date et heure)." },
      { name: "receivedAt", type: "date", description: "Arrivée." },
      { name: "acknowledgedAt", type: "date", description: "Accusé de réception." },
      { name: "carrier", type: "string", description: "Porteur." },
      { name: "notes", type: "string", description: "Notes." },
      { name: "departmentId", type: "string", description: "Direction (département) concernée — valeur vide pour la retirer." },
      { name: "concernedUserId", type: "string", description: "Personne concernée — valeur vide pour la retirer." },
    ],
    run: (user, i) => updateMailEntryFor(user, String(i.id), correctionDepuisApi(i)),
  },
  {
    name: "mail.set_date",
    label: "Poser l'arrivée ou l'accusé de réception",
    description:
      "Pose (ou efface, avec une valeur vide) l'une des deux dates qui se constatent après coup. "
      + "Journalisé comme le formulaire complet — c'est par là qu'une date se corrige.",
    module: "MAIL_REGISTER",
    scope: "erp.write",
    entityType: "MAIL_ENTRY",
    params: [
      { name: "id", type: "string", required: true, description: "Identifiant du courrier." },
      { name: "field", type: "enum", required: true, values: ["receivedAt", "acknowledgedAt"], description: "Date à poser." },
      { name: "value", type: "date", description: "La date. Vide = effacer." },
    ],
    run: (user, i) => setMailDateFor(user, {
      id: String(i.id),
      field: String(i.field) as "receivedAt" | "acknowledgedAt",
      value: i.value instanceof Date ? i.value : null,
    }),
  },
  {
    name: "product.link_dossier",
    label: "Rattacher un produit à son dossier réglementaire",
    description:
      "Déclare qu'un produit du Business Development ou du planning promotionnel correspond à un "
      + "dossier réglementaire. ATTENTION : un dosage différent est un produit différent (500 mg et "
      + "1 g sont deux AMM). À n'appeler que sur une correspondance certaine.",
    module: "REGULATORY",
    scope: "erp.write",
    entityType: "REGULATORY_PRODUCT",
    params: [
      { name: "kind", type: "enum", required: true, values: ["BD", "PROMO"], description: "Catalogue d'origine du produit." },
      { name: "id", type: "string", required: true, description: "Identifiant du produit à rattacher." },
      { name: "regulatoryProductId", type: "string", required: true, description: "Identifiant du dossier réglementaire." },
    ],
    run: (user, i) => linkProductToDossierFor(user, {
      kind: String(i.kind) as CatalogKind,
      id: String(i.id),
      regulatoryProductId: String(i.regulatoryProductId),
    }),
  },
  {
    name: "product.unlink_dossier",
    label: "Défaire un rattachement de produit",
    description: "Retire le lien entre un produit et son dossier réglementaire.",
    module: "REGULATORY",
    scope: "erp.write",
    entityType: "REGULATORY_PRODUCT",
    params: [
      { name: "kind", type: "enum", required: true, values: ["BD", "PROMO"], description: "Catalogue d'origine du produit." },
      { name: "id", type: "string", required: true, description: "Identifiant du produit." },
    ],
    run: (user, i) => unlinkProductFromDossierFor(user, {
      kind: String(i.kind) as CatalogKind,
      id: String(i.id),
    }),
  },
] as const;

/** L'opération portant ce nom, ou `null`. Un nom inconnu n'ouvre rien. */
export function getOperation(name: string): OperationDef | null {
  return OPERATIONS.find((o) => o.name === name) ?? null;
}

export type ValidationResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * VALIDER LES PARAMÈTRES — et refuser plutôt que corriger.
 *
 * Un agent se trompe autrement qu'un humain : il invente un nom de champ plausible, envoie une
 * date au mauvais format, ou passe une valeur hors de l'énumération. Deviner ce qu'il « voulait
 * dire » produirait une écriture que personne n'a demandée. On refuse, en DISANT quoi corriger.
 *
 * Les paramètres inconnus sont refusés eux aussi : acceptés en silence, ils feraient croire à
 * l'agent que son intention a été prise en compte alors qu'elle a été ignorée.
 *
 * Fonction PURE — c'est le cœur testable du registre.
 */
export function validateParams(def: OperationDef, raw: unknown): ValidationResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Le corps doit être un objet de paramètres." };
  }
  const input = raw as Record<string, unknown>;
  const known = new Set(def.params.map((p) => p.name));
  const unknownKeys = Object.keys(input).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Paramètre(s) inconnu(s) : ${unknownKeys.join(", ")}. Attendus : ${[...known].join(", ")}.` };
  }

  const values: Record<string, unknown> = {};
  for (const p of def.params) {
    // UN PARAMÈTRE ABSENT N'EST PAS UN PARAMÈTRE VIDE. Absent, il ne figure pas dans le résultat —
    // une correction partielle n'en parle donc pas ; présent et vide, il vaut `null` — un effacement
    // demandé. Les confondre faisait de toute correction partielle un effacement général.
    if (!Object.prototype.hasOwnProperty.call(input, p.name) || input[p.name] === undefined) {
      if (p.required) return { ok: false, error: `Le paramètre « ${p.name} » est obligatoire.` };
      continue;
    }
    const v = input[p.name];
    const empty = v == null || v === "";
    if (empty) {
      if (p.required) return { ok: false, error: `Le paramètre « ${p.name} » est obligatoire.` };
      values[p.name] = null;
      continue;
    }
    switch (p.type) {
      case "string":
        values[p.name] = String(v);
        break;
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) return { ok: false, error: `« ${p.name} » doit être un nombre.` };
        values[p.name] = n;
        break;
      }
      case "boolean":
        values[p.name] = v === true || v === "true" || v === 1 || v === "1";
        break;
      case "date": {
        const d = new Date(String(v));
        if (Number.isNaN(d.getTime())) {
          return { ok: false, error: `« ${p.name} » doit être une date ISO (ex. « 2026-08-17 » ou « 2026-08-17T14:30:00Z »).` };
        }
        values[p.name] = d;
        break;
      }
      case "enum": {
        const t = String(v);
        if (!p.values?.includes(t)) {
          return { ok: false, error: `« ${p.name} » doit valoir l'une de ces valeurs : ${(p.values ?? []).join(", ")}.` };
        }
        values[p.name] = t;
        break;
      }
    }
  }
  return { ok: true, values };
}

/** Le catalogue tel qu'un agent le découvre — sans les fonctions, qui ne se sérialisent pas. */
export function describeOperations() {
  return OPERATIONS.map((o) => ({
    name: o.name,
    label: o.label,
    description: o.description,
    module: o.module,
    scope: o.scope,
    entityType: o.entityType ?? null,
    params: o.params.map((p) => ({
      name: p.name, type: p.type, required: Boolean(p.required),
      description: p.description, values: p.values ?? null,
    })),
  }));
}
