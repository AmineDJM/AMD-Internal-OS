import type { RolePersonne, TypeIdentifiantOrganisation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { plier } from "@/modules/referentiels/partage";
import type { CandidatFiche } from "./decision";
import { estPorteurDePersonne, type PorteurDePersonne } from "./sujets";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES QUE L'ENRICHISSEMENT LIT — personnes des rattachements, organisations par identifiant.
 *
 * Serveur seulement. Lectures étroites (`select`), une écriture et une seule : la Personne d'une
 * fiche qui n'en a pas encore (voir `personneDuPorteur`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ROLE_DU_PORTEUR: Record<Exclude<PorteurDePersonne, "PERSONNE">, RolePersonne> = {
  AD_PRO_VOYAGEUR: "VOYAGEUR",
  AD_PRO_HEBERGEMENT: "VOYAGEUR",
  EMPLOYEE: "COLLABORATEUR",
  RECRUITMENT_CANDIDATE: "CANDIDAT",
};

interface Porteur { personneId: string | null; nom: string; prenoms: string | null }

async function lirePorteur(type: Exclude<PorteurDePersonne, "PERSONNE">, id: string): Promise<Porteur | null> {
  switch (type) {
    case "AD_PRO_VOYAGEUR": {
      const v = await prisma.adProVoyageur.findUnique({ where: { id }, select: { personneId: true, nom: true, prenom: true } });
      return v && { personneId: v.personneId, nom: v.nom, prenoms: v.prenom };
    }
    case "AD_PRO_HEBERGEMENT": {
      const h = await prisma.adProHebergement.findUnique({ where: { id }, select: { personneId: true, nom: true, prenom: true } });
      return h && { personneId: h.personneId, nom: h.nom, prenoms: h.prenom };
    }
    case "EMPLOYEE": {
      const e = await prisma.employee.findUnique({ where: { id }, select: { personneId: true, fullName: true } });
      return e && { personneId: e.personneId, nom: e.fullName, prenoms: null };
    }
    case "RECRUITMENT_CANDIDATE": {
      const c = await prisma.recruitmentCandidate.findUnique({ where: { id }, select: { personneId: true, fullName: true } });
      return c && { personneId: c.personneId, nom: c.fullName, prenoms: null };
    }
  }
}

/** Pose `personneId` sur la fiche porteuse SEULEMENT si elle n'en a pas — rend vrai si c'est fait. */
async function lierPorteur(type: Exclude<PorteurDePersonne, "PERSONNE">, id: string, personneId: string): Promise<boolean> {
  const where = { id, personneId: null };
  const data = { personneId };
  switch (type) {
    case "AD_PRO_VOYAGEUR": return (await prisma.adProVoyageur.updateMany({ where, data })).count === 1;
    case "AD_PRO_HEBERGEMENT": return (await prisma.adProHebergement.updateMany({ where, data })).count === 1;
    case "EMPLOYEE": return (await prisma.employee.updateMany({ where, data })).count === 1;
    case "RECRUITMENT_CANDIDATE": return (await prisma.recruitmentCandidate.updateMany({ where, data })).count === 1;
  }
}

/**
 * LA PERSONNE D'UNE FICHE PORTEUSE (voyageur, hébergé, salarié, candidat). Si la fiche n'est pas
 * encore rapprochée du référentiel (reprise R1 pas encore passée), la Personne est CRÉÉE avec ce que
 * la fiche dit déjà d'elle — son nom et ses prénoms tels que saisis, jamais ceux de la pièce : la
 * pièce ne fait que PROPOSER — puis liée, sous condition (`personneId` encore nul). La reprise R1
 * retrouvera la fiche déjà liée et n'en créera pas une seconde ; un doublon avec une autre Personne
 * (le même médecin venu d'ailleurs) sera PROPOSÉ par le dédoublonnage, jamais fusionné ici.
 */
export async function personneDuPorteur(type: PorteurDePersonne, id: string): Promise<string | null> {
  if (type === "PERSONNE") {
    const p = await prisma.personne.findUnique({ where: { id }, select: { id: true, fusionneeDansId: true } });
    return p ? (p.fusionneeDansId ?? p.id) : null;
  }
  const porteur = await lirePorteur(type, id);
  if (!porteur) return null;
  if (porteur.personneId) return porteur.personneId;
  const nom = porteur.nom.trim();
  if (!nom) return null;
  const prenoms = porteur.prenoms?.trim() || null;
  const creee = await prisma.personne.create({
    data: {
      nom, prenoms, nomReplie: plier(`${nom} ${prenoms ?? ""}`),
      roles: { create: { role: ROLE_DU_PORTEUR[type] } },
    },
    select: { id: true },
  });
  if (await lierPorteur(type, id, creee.id)) return creee.id;
  // Une autre écriture a lié la fiche entre-temps : la nôtre ne sert à rien, la sienne fait foi.
  await prisma.personne.delete({ where: { id: creee.id } }).catch(() => undefined);
  return (await lirePorteur(type, id))?.personneId ?? null;
}

/**
 * LES FICHES PORTEUSES D'UNE PIÈCE, d'après ses liens : un lien direct (le voyageur, la personne), ou
 * le DOCUMENT de module qui la porte — rattaché à un salarié, à un candidat, ou au poste Ad & Pro à
 * l'étape d'un voyageur ou d'une fiche hôtellerie (`stepKey`). C'est ce qui fait qu'un passeport
 * déposé « sur le poste, au nom du voyageur » se rapporte au voyageur, quel que soit l'écran de dépôt.
 */
export async function porteursDesLiens(liens: readonly { sujetType: string; sujetId: string; entityType: string | null }[]): Promise<{ type: PorteurDePersonne; id: string }[]> {
  const porteurs: { type: PorteurDePersonne; id: string }[] = [];
  for (const l of liens) {
    const type = l.sujetType === "PERSONNE" ? "PERSONNE" : l.entityType;
    if (type && estPorteurDePersonne(type)) porteurs.push({ type, id: l.sujetId });
    if (type !== "DOCUMENT") continue;
    const d = await prisma.document.findUnique({ where: { id: l.sujetId }, select: { entityType: true, entityId: true, stepKey: true } });
    if (!d) continue;
    if (d.entityType === "EMPLOYEE" || d.entityType === "RECRUITMENT_CANDIDATE") porteurs.push({ type: d.entityType, id: d.entityId });
    if (d.entityType === "AD_PRO_ITEM" && d.stepKey) {
      const [v, h] = await Promise.all([
        prisma.adProVoyageur.findFirst({ where: { id: d.stepKey, itemId: d.entityId }, select: { id: true } }),
        prisma.adProHebergement.findFirst({ where: { id: d.stepKey, itemId: d.entityId }, select: { id: true } }),
      ]);
      if (v) porteurs.push({ type: "AD_PRO_VOYAGEUR", id: v.id });
      if (h) porteurs.push({ type: "AD_PRO_HEBERGEMENT", id: h.id });
    }
  }
  const vus = new Set<string>();
  return porteurs.filter((p) => !vus.has(`${p.type}:${p.id}`) && !!vus.add(`${p.type}:${p.id}`));
}

/** Les fiches Personne, avec les empreintes de leurs identifiants au coffre — candidates à `resoudreSujet`. */
export async function candidatsPersonnes(ids: readonly string[], natures: Record<string, string>): Promise<CandidatFiche[]> {
  if (ids.length === 0) return [];
  const [personnes, coffre] = await Promise.all([
    prisma.personne.findMany({ where: { id: { in: [...ids] } }, select: { id: true, nom: true, prenoms: true } }),
    prisma.donneeSensible.findMany({
      where: { titulaireType: "PERSONNE", titulaireId: { in: [...ids] }, nature: { in: Object.values(natures) } },
      select: { titulaireId: true, nature: true, empreinteHmac: true },
    }),
  ]);
  const attributDe = Object.fromEntries(Object.entries(natures).map(([attribut, nature]) => [nature, attribut]));
  return personnes.map((p) => ({
    id: p.id,
    type: "PERSONNE" as const,
    libelle: [p.prenoms, p.nom].filter(Boolean).join(" "),
    identifiants: coffre.filter((d) => d.titulaireId === p.id).map((d) => ({ attribut: attributDe[d.nature], empreinte: d.empreinteHmac })),
  }));
}

/** Les personnes qui tiennent au coffre une donnée de cette nature sous cette empreinte. */
export async function personnesParEmpreinte(nature: string, empreinte: string): Promise<string[]> {
  const lignes = await prisma.donneeSensible.findMany({
    where: { titulaireType: "PERSONNE", nature, empreinteHmac: empreinte },
    select: { titulaireId: true },
    take: 20,
  });
  return [...new Set(lignes.map((l) => l.titulaireId).filter((id): id is string => id !== null))];
}

const TYPE_IDENTIFIANT: Record<string, TypeIdentifiantOrganisation> = {
  "organisation.nif": "NIF", "organisation.nis": "NIS", "organisation.rc": "RC", "organisation.ai": "AI",
};
const compacte = (v: string) => v.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Les organisations qui portent l'un de ces identifiants (NIF, NIS, RC, AI) — candidates à `resoudreSujet`. */
export async function candidatsOrganisations(lus: readonly { attribut: string; valeurNormalisee: string }[]): Promise<CandidatFiche[]> {
  const cherches = lus
    .filter((l) => TYPE_IDENTIFIANT[l.attribut] && l.valeurNormalisee.trim())
    .map((l) => ({ type: TYPE_IDENTIFIANT[l.attribut], valeurNormalisee: compacte(l.valeurNormalisee) }));
  if (cherches.length === 0) return [];
  const trouves = await prisma.organisationIdentifiant.findMany({ where: { OR: cherches }, select: { organisationId: true }, take: 20 });
  const ids = [...new Set(trouves.map((t) => t.organisationId))];
  if (ids.length === 0) return [];
  const orgs = await prisma.organisation.findMany({
    where: { id: { in: ids }, fusionneeDansId: null },
    select: { id: true, raisonSociale: true, identifiants: { select: { type: true, valeurNormalisee: true } } },
  });
  const attributDe = Object.fromEntries(Object.entries(TYPE_IDENTIFIANT).map(([a, t]) => [t, a]));
  // `resoudreSujet` compare des valeurs normalisées : on lui rend la forme compacte des deux côtés.
  return orgs.map((o) => ({
    id: o.id,
    type: "ORGANISATION" as const,
    libelle: o.raisonSociale,
    identifiants: o.identifiants.filter((i) => attributDe[i.type]).map((i) => ({ attribut: attributDe[i.type], valeurNormalisee: compacte(i.valeurNormalisee) })),
  }));
}

export { compacte as compacterIdentifiant };
