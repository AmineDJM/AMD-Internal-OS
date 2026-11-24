import type { EntityType } from "@prisma/client";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { lienCourrier } from "@/lib/chemins/courriers";

/**
 * D'OÙ VIENT UN ENGAGEMENT — le lien entre une pièce et ce qui l'a fait naître.
 *
 * Un bon de commande naît d'une demande de sponsoring ; une facture naît d'un événement ou d'une
 * demande au secrétariat ; un courrier accompagne un marché PCH. Ces liens existent dans la vraie
 * vie et se perdent dans l'ERP : chaque objet vit dans son module, et six semaines plus tard
 * personne ne sait plus quelle facture correspond à quelle demande.
 *
 * Les modèles portaient déjà `sourceType` / `sourceId`. Ce module dit ce qu'on en fait :
 * QUELS objets peuvent être une source, COMMENT on les nomme, et OÙ l'on va en cliquant. C'est
 * une carte, pas une base : d'où les tests, et d'où l'absence totale d'import lourd.
 *
 * Un type ABSENT de la carte n'est pas une erreur : c'est un objet vers lequel on ne sait pas
 * (encore) naviguer. On l'affiche alors sans lien plutôt que d'envoyer sur une page inexistante —
 * un lien mort coûte plus cher que pas de lien.
 */

/** Les objets métier qui peuvent être la SOURCE d'une pièce, et la route de leur fiche. */
export const LINKABLE_SOURCES: Partial<Record<EntityType, (id: string) => string>> = {
  SPONSORING: (id) => `/sponsoring/${id}`,
  CONGRESS_INTERNATIONAL: (id) => `/congress-international/${id}`,
  CONGRESS_NATIONAL: (id) => `/congress-national/${id}`,
  EVENT: (id) => `/events/${id}`,
  PROMO_MATERIAL: (id) => `/promo-material/${id}`,
  CONSULTING_CONTRACT: (id) => `/consulting/${id}`,
  AD_PRO_OTHER: (id) => `/ad-pro/autres/${id}`,
  ADMIN_REQUEST: (id) => `/demandes/${id}`,
  PCH_TENDER: (id) => `/pch/${id}`,
  REGULATORY_PRODUCT: (id) => `/regulatory/${id}`,
  DOSSIER: (id) => `/dossiers/${id}`,
  BD_PROJECT: (id) => `/business-development/projets/${id}`,
  MAIL_ENTRY: (id) => lienCourrier(id),
  LEGAL_DOCUMENT: (id) => `/legal/${id}`,
};

/** Peut-on cliquer pour aller voir cette source ? */
export function isLinkableSource(type: string | null | undefined): type is EntityType {
  return Boolean(type && type in LINKABLE_SOURCES);
}

/** La route de la fiche source, ou `null` si l'on ne sait pas y aller. */
export function sourceHref(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id || !isLinkableSource(type)) return null;
  return LINKABLE_SOURCES[type]!(id);
}

/** Le nom lisible du type de source (« Demande administrative », « Sponsoring »…). */
export function sourceLabel(type: string | null | undefined): string {
  if (!type) return "—";
  return ENTITY_TYPE_LABELS[type] ?? type;
}

/**
 * La ligne « Rattaché à … » telle qu'elle se lit.
 *
 * `reference` est ce que la personne a sous les yeux dans l'écran d'origine (« SPO-2026-014 ») ;
 * sans elle, on se rabat sur le type seul — jamais sur un identifiant technique, qui n'apprend
 * rien à personne et donne l'air d'une fuite de base de données.
 */
export function sourceCaption(type: string | null | undefined, reference?: string | null): string | null {
  if (!type) return null;
  const label = sourceLabel(type);
  const ref = (reference ?? "").trim();
  return ref ? `${label} ${ref}` : label;
}
