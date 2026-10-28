import { MODULES } from "@/lib/rbac";
import { isHideable } from "@/lib/modules-visibility";
import { COLONNES_REGULATORY, lireColonnesMasquees } from "@/lib/vues/colonnes-regulatory";

/**
 * CE QUE L'ASSISTANT A LE DROIT D'ÉCRIRE — la liste blanche, et rien d'autre.
 *
 * Donner à un modèle de langage la main sur les réglages de la plateforme et sur les dossiers
 * réglementaires est utile — c'est précisément ce qu'on lui demande — mais cela ne peut pas
 * passer par du JSON libre. Un modèle qui se trompe de champ, d'unité ou d'ordre de grandeur
 * écrirait une valeur qu'aucun écran n'aurait acceptée, et le prochain à s'en apercevoir serait
 * l'utilisateur devant un Drive à 0 Go.
 *
 * D'où ce module : un CATALOGUE déclaratif des réglages et des champs modifiables, avec pour
 * chacun son type, ses bornes et son domaine de valeurs. Ce qui n'y figure pas n'est pas
 * écrivable, quoi que le modèle propose. Et chaque valeur est RELUE ici avant d'atteindre la
 * base — la confirmation de l'utilisateur ne remplace pas la validation : on ne relit pas un
 * nombre à quatre chiffres dans une carte de confirmation.
 *
 * Module PUR — testé, sans base de données.
 */

// ───────────────────────────── Réglages de la plateforme ─────────────────────────────

export type SettingKind = "number" | "boolean" | "roles" | "modules" | "strings" | "enum" | "regColumns";

export interface SettingSpec {
  key: string;
  label: string;
  kind: SettingKind;
  /** Bornes d'un nombre — refuser hors bornes plutôt que d'écrire une valeur absurde. */
  min?: number;
  max?: number;
  /** Domaine d'un `enum`. */
  values?: readonly string[];
  /** Ce que le réglage fait, en une phrase — repris dans la carte de confirmation. */
  hint: string;
  /** Conséquence à ANNONCER quand elle n'est pas évidente à la lecture du nom. */
  warning?: string;
}

/**
 * Les réglages que l'assistant peut modifier.
 *
 * Volontairement identiques à ceux de la console d'administration : l'assistant est un autre
 * chemin vers les mêmes leviers, pas un chemin vers des leviers cachés.
 */
export const WRITABLE_SETTINGS: readonly SettingSpec[] = [
  { key: "maxUploadMb", label: "Taille maximale d'un téléversement (Mo)", kind: "number", min: 1, max: 4096,
    hint: "Plafond d'un fichier joint dans les modules." },
  { key: "maxDriveUploadMb", label: "Taille maximale d'un fichier du Drive (Mo)", kind: "number", min: 1, max: 10240,
    hint: "Plafond d'un fichier déposé dans le Drive." },
  { key: "driveCapacityGb", label: "Capacité globale du Drive (Go)", kind: "number", min: 1, max: 100_000,
    hint: "Espace total de la plateforme." },
  { key: "driveUserQuotaGb", label: "Quota Drive par personne (Go)", kind: "number", min: 1, max: 10_000,
    hint: "Espace alloué à chaque compte." },
  { key: "budgetTotalMode", label: "Mode du budget total", kind: "enum", values: ["FIXED", "FLEXIBLE"],
    hint: "FIXED : un montant figé. FLEXIBLE : la somme des enveloppes." },
  { key: "budgetFixedTotal", label: "Budget total figé (DZD)", kind: "number", min: 0, max: 1_000_000_000_000,
    hint: "N'a d'effet qu'en mode FIXED." },
  { key: "aiExternalActionsDisabled", label: "ARRÊT D'URGENCE — actions externes de l'IA désactivées", kind: "boolean",
    hint: "Vrai = l'assistant ne peut plus RIEN exécuter qui touche le monde réel (messages, e-mails, tâches pour autrui, mutations métier, relances planifiées) — même confirmé. Les lectures et analyses continuent.",
    warning: "Interrupteur global : il coupe les actions de l'assistant pour TOUT LE MONDE jusqu'à sa désactivation." },
  { key: "regEnrollmentEnabled", label: "Analyse CTD (Enregistrement) activée", kind: "boolean",
    hint: "Ouvre ou ferme l'onglet d'analyse réglementaire." },
  { key: "regulatorySupervisorRoles", label: "Rôles superviseurs Regulatory", kind: "roles",
    hint: "Priorités, dates cibles et demandes de mise à jour de statut." },
  { key: "regulatoryTherapeuticSegments", label: "Segments thérapeutiques", kind: "strings",
    hint: "La liste proposée par le tableau Regulatory. Vide = la liste par défaut." },
  { key: "regulatoryHiddenColumns", label: "Colonnes masquées du tableau Regulatory", kind: "regColumns",
    hint: `Les colonnes retirées du tableau, sur les DEUX sous-modules (Suivi de dossiers et Pipeline). Se donnent par leur nom d'en-tête : ${COLONNES_REGULATORY.map((c) => c.header).join(", ")}. Une liste vide remet toutes les colonnes.`,
    warning: "La colonne disparaît pour TOUT LE MONDE, dans le Suivi de dossiers comme dans le Pipeline. Les données ne sont pas effacées : elles restent sur la fiche du dossier et reviennent dès que la colonne est remise." },
  { key: "regEnrollmentRoles", label: "Rôles voyant l'onglet Enregistrement (CTD)", kind: "roles",
    hint: "Vide = le Super Admin seul." },
  { key: "driveSpaceCreatorRoles", label: "Rôles pouvant créer des catégories de Drive", kind: "roles",
    hint: "En plus du Super Admin." },
  { key: "fieldReportsOverviewRoles", label: "Rôles voyant l'Overview des rapports terrain", kind: "roles",
    hint: "En plus du Super Admin." },
  { key: "orgChartViewerRoles", label: "Rôles pouvant consulter l'organigramme", kind: "roles",
    hint: "En plus du Super Admin." },
  { key: "directiveReaderRoles", label: "Rôles pouvant lire les directives", kind: "roles",
    hint: "En plus des droits du rôle. La PUBLICATION reste au Directeur Général : elle ne se règle pas." },
  { key: "directiveIssuerRoles", label: "Rôles pouvant rédiger une directive", kind: "roles",
    hint: "Rédiger et SOUMETTRE une note de service ; la publier reste à la direction générale.",
    warning: "Une note rédigée engage l'entreprise dès qu'elle est publiée : n'ouvrez la rédaction qu'à ceux qui préparent réellement les consignes." },
  { key: "hiddenModules", label: "Modules masqués", kind: "modules",
    hint: "Modules retirés de la plateforme (menu ET adresse).",
    warning: "Un module masqué disparaît pour TOUT LE MONDE, menu et adresse directe comprises. Seul le Super Admin continue de le voir." },
] as const;

export function settingSpec(key: string): SettingSpec | null {
  return WRITABLE_SETTINGS.find((s) => s.key === key) ?? null;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Découpe une liste écrite en clair (« Direction, Responsable Ventes »). */
function splitList(raw: string): string[] {
  return raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Valide et convertit la valeur proposée pour un réglage.
 *
 * `roleLabels` et `moduleLabels` viennent de l'appelant (les libellés français de la
 * plateforme) : on accepte le NOM tel qu'un humain l'écrirait — « Direction », « Responsable
 * Réglementaire » — parce que c'est ce que le modèle aura repris de la conversation, et non un
 * code interne qu'il aurait dû deviner.
 */
export function parseSettingValue(
  key: string,
  raw: unknown,
  ctx: { roleLabels?: Record<string, string>; moduleLabels?: Record<string, string> } = {},
): ParseResult<number | boolean | string | string[]> {
  const spec = settingSpec(key);
  if (!spec) {
    return { ok: false, error: `Réglage « ${key} » inconnu ou non modifiable. Réglages disponibles : ${WRITABLE_SETTINGS.map((s) => s.key).join(", ")}.` };
  }
  const text = raw == null ? "" : String(raw).trim();

  switch (spec.kind) {
    case "number": {
      const n = Number(text.replace(/\s/g, "").replace(",", "."));
      if (!Number.isFinite(n)) return { ok: false, error: `« ${spec.label} » attend un nombre.` };
      if (spec.min != null && n < spec.min) return { ok: false, error: `« ${spec.label} » ne peut pas descendre sous ${spec.min}.` };
      if (spec.max != null && n > spec.max) return { ok: false, error: `« ${spec.label} » ne peut pas dépasser ${spec.max}.` };
      return { ok: true, value: n };
    }
    case "boolean": {
      const t = text.toLowerCase();
      if (["true", "oui", "1", "actif", "active", "activé", "activee", "activée"].includes(t)) return { ok: true, value: true };
      if (["false", "non", "0", "inactif", "désactivé", "desactive", "désactivée"].includes(t)) return { ok: true, value: false };
      return { ok: false, error: `« ${spec.label} » attend oui ou non.` };
    }
    case "enum": {
      const up = text.toUpperCase();
      if (!(spec.values ?? []).includes(up)) {
        return { ok: false, error: `« ${spec.label} » n'accepte que : ${(spec.values ?? []).join(", ")}.` };
      }
      return { ok: true, value: up };
    }
    case "strings":
      return { ok: true, value: [...new Set(splitList(text))] };
    case "regColumns": {
      // LE CATALOGUE FAIT FOI, ET IL EST PARTAGÉ AVEC L'ÉCRAN. Un libellé inconnu ne s'ignore
      // pas : Adam annoncerait « c'est fait » sur une colonne qui n'a pas bougé, et la référence
      // ne se masque jamais — sans elle on ne sait plus de quel dossier parle la ligne.
      const lu = lireColonnesMasquees(text);
      return lu.ok ? { ok: true, value: lu.cles } : { ok: false, error: lu.error };
    }
    case "roles": {
      const labels = ctx.roleLabels ?? {};
      const out: string[] = [];
      const unknown: string[] = [];
      for (const item of splitList(text)) {
        const code = resolveByLabel(item, labels);
        if (code) out.push(code); else unknown.push(item);
      }
      if (unknown.length > 0) {
        return { ok: false, error: `Rôle(s) inconnu(s) : ${unknown.join(", ")}. Rôles existants : ${Object.values(labels).join(", ")}.` };
      }
      return { ok: true, value: [...new Set(out)] };
    }
    case "modules": {
      const labels = ctx.moduleLabels ?? {};
      const out: string[] = [];
      const unknown: string[] = [];
      const forbidden: string[] = [];
      for (const item of splitList(text)) {
        const code = resolveByLabel(item, labels) ?? ((MODULES as readonly string[]).includes(item.toUpperCase()) ? item.toUpperCase() : null);
        if (!code) { unknown.push(item); continue; }
        // La console d'administration ne se masque jamais : la cacher fermerait la porte de
        // l'intérieur, sans aucun moyen de la rouvrir autrement qu'en écrivant en base.
        if (!isHideable(code)) { forbidden.push(item); continue; }
        out.push(code);
      }
      if (unknown.length > 0) return { ok: false, error: `Module(s) inconnu(s) : ${unknown.join(", ")}.` };
      if (forbidden.length > 0) return { ok: false, error: `Impossible de masquer : ${forbidden.join(", ")}. La console d'administration doit rester atteignable.` };
      return { ok: true, value: [...new Set(out)] };
    }
    default:
      return { ok: false, error: "Type de réglage non pris en charge." };
  }
}

/** Retrouve un code depuis son libellé français (ou son code écrit tel quel). Insensible aux accents. */
function resolveByLabel(input: string, labels: Record<string, string>): string | null {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const needle = norm(input);
  for (const [code, label] of Object.entries(labels)) {
    if (norm(code) === needle || norm(label) === needle) return code;
  }
  return null;
}

/** La valeur, écrite comme on la lit dans une carte de confirmation. */
export function renderSettingValue(value: unknown, labels: Record<string, string> = {}): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? "(aucun)" : value.map((v) => labels[String(v)] ?? String(v)).join(", ");
  }
  if (typeof value === "boolean") return value ? "oui" : "non";
  const s = String(value ?? "").trim();
  return s || "(vide)";
}

// ───────────────────────────── Champs d'un dossier Regulatory ─────────────────────────────

export interface RegFieldSpec {
  field: string;
  label: string;
  kind: "text" | "enum" | "date" | "strings" | "boolean";
  values?: readonly string[];
  warning?: string;
}

/**
 * Les champs d'un dossier réglementaire que l'assistant peut modifier.
 *
 * Ce qui n'y est PAS, et pourquoi : la RÉFÉRENCE (elle identifie le dossier, la changer romprait
 * tous les renvois qui la citent) et l'ENTITÉ (elle a son propre outil, `set_products_company`,
 * qui sait résoudre un nom de société et traiter un lot).
 */
export const WRITABLE_REG_FIELDS: readonly RegFieldSpec[] = [
  { field: "status", label: "Statut réglementaire", kind: "enum",
    values: ["PRE_SUBMISSION", "IN_PREPARATION", "SUBMITTED", "AWAITING_BV_PAYMENT", "AWAITING_ANPP", "RESPONDING_TO_QUERIES", "DECISION_OBTAINED", "BLOCKED", "CLOSED"] },
  { field: "priority", label: "Priorité", kind: "enum", values: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
  { field: "category", label: "Catégorie", kind: "enum", values: ["MEDICINE", "MEDICAL_DEVICE"] },
  { field: "channel", label: "Canal", kind: "enum", values: ["RETAIL", "HOSPITAL", "BOTH"] },
  { field: "brandName", label: "Nom commercial", kind: "text" },
  { field: "dosage", label: "Dosage", kind: "text" },
  { field: "dosageUnit", label: "Unité de dosage", kind: "text" },
  { field: "pharmaceuticalForm", label: "Forme galénique", kind: "text" },
  { field: "packaging", label: "Conditionnement", kind: "text" },
  { field: "therapeuticClass", label: "Classe thérapeutique", kind: "text" },
  { field: "therapeuticSegments", label: "Segments thérapeutiques", kind: "strings" },
  { field: "partnerLab", label: "Laboratoire partenaire", kind: "text" },
  { field: "countryOfOrigin", label: "Pays d'origine", kind: "text" },
  { field: "deHolder", label: "Détenteur de la décision d'enregistrement", kind: "text" },
  { field: "manufacturer", label: "Fabricant", kind: "text" },
  { field: "targetSubmissionDate", label: "Date cible de dépôt", kind: "date" },
  { field: "targetDate", label: "Date cible d'enregistrement", kind: "date" },
  { field: "comments", label: "Commentaires", kind: "text" },
  { field: "isLocked", label: "Cadenas (dossier au pipeline)", kind: "boolean",
    warning: "Un dossier verrouillé devient INVISIBLE pour toute l'équipe — y compris la Direction et son propre responsable. Seul le Super Admin le voit encore." },
] as const;

export function regFieldSpec(field: string): RegFieldSpec | null {
  return WRITABLE_REG_FIELDS.find((f) => f.field === field) ?? null;
}

/** Valide et convertit la valeur proposée pour un champ de dossier. */
export function parseRegFieldValue(field: string, raw: unknown): ParseResult<string | string[] | boolean | Date | null> {
  const spec = regFieldSpec(field);
  if (!spec) {
    return { ok: false, error: `Champ « ${field} » inconnu ou non modifiable. Champs disponibles : ${WRITABLE_REG_FIELDS.map((f) => f.field).join(", ")}.` };
  }
  const text = raw == null ? "" : String(raw).trim();

  switch (spec.kind) {
    case "enum": {
      const up = text.toUpperCase().replace(/[\s-]/g, "_");
      if (!(spec.values ?? []).includes(up)) {
        return { ok: false, error: `« ${spec.label} » n'accepte que : ${(spec.values ?? []).join(", ")}.` };
      }
      return { ok: true, value: up };
    }
    case "boolean": {
      const t = text.toLowerCase();
      if (["true", "oui", "1", "verrouillé", "verrouille"].includes(t)) return { ok: true, value: true };
      if (["false", "non", "0", "déverrouillé", "deverrouille"].includes(t)) return { ok: true, value: false };
      return { ok: false, error: `« ${spec.label} » attend oui ou non.` };
    }
    case "date": {
      // Une date vide EFFACE la cible : c'est un geste légitime (« on ne vise plus de date »),
      // à ne pas confondre avec une saisie ratée — d'où le refus explicite d'un texte illisible.
      if (!text) return { ok: true, value: null };
      const d = new Date(text);
      if (Number.isNaN(d.getTime())) return { ok: false, error: `« ${spec.label} » attend une date (AAAA-MM-JJ).` };
      return { ok: true, value: d };
    }
    case "strings":
      return { ok: true, value: [...new Set(text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean))] };
    default:
      return { ok: true, value: text || null };
  }
}

/** « Priorité : Moyenne → Critique » — la ligne que l'on relit dans le journal. */
export function describeChange(label: string, before: unknown, after: unknown): string {
  const r = (v: unknown) => renderSettingValue(v);
  return `${label} : ${r(before)} → ${r(after)}`;
}
