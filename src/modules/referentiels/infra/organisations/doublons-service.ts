import { prisma } from "@/lib/prisma";
import { proposerDoublonsOrganisations, type FicheOrganisation, type PropositionDoublon } from "../../domaine/doublons";
import { proposerDoublon } from "../../domaine/organisations/ecriture";
import { noterErreur } from "../../domaine/reprises/lots";
import { bilanVide, type BilanReprise } from "../../domaine/reprises/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DOUBLONS D'ORGANISATIONS, PROPOSÉS — jamais fusionnés d'office.
 *
 * Chaque organisation VIVANTE (non fusionnée) devient une `FicheOrganisation` : son nom, ses identifiants,
 * et les coordonnées que portent ses fiches d'origine (wilaya, e-mails, téléphones des partenaires, des
 * établissements, des fournisseurs, de l'identité légale des sociétés). `referentiels/doublons.ts` compare
 * par blocs et rend des paires avec un niveau et leurs raisons lisibles ; elles sont ENREGISTRÉES ici
 * (`PropositionDoublonOrganisation`), une ligne par paire. Une paire déjà tranchée (écartée, fusionnée)
 * n'est jamais rouverte.
 *
 * Les identifiants des sociétés du GROUPE recopiés sur un tiers ne rapprochent rien (le NIF du client lu
 * sur une facture pris pour celui de l'émetteur).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

async function fichesOrganisations(): Promise<{ fiches: FicheOrganisation[]; groupe: { nifs: string[]; rcs: string[]; nis: string[] } }> {
  const orgs = await prisma.organisation.findMany({
    where: { fusionneeDansId: null },
    orderBy: { id: "asc" },
    select: {
      id: true, raisonSociale: true,
      roles: { select: { role: true } },
      identifiants: { select: { type: true, valeur: true } },
      companies: { select: { legalIdentity: { select: { nif: true, nis: true, rcNumber: true, taxArticle: true, phone: true, email: true } } } },
      companyContacts: { select: { nif: true, rc: true, wilaya: true, city: true, email: true, phone: true, phoneAlt: true } },
      suppliers: { select: { city: true, contactEmail: true, phone: true } },
      medicalInstitutions: { select: { wilaya: true, city: true, email: true, phone: true } },
    },
  });
  const groupe = { nifs: [] as string[], rcs: [] as string[], nis: [] as string[] };
  const fiches = orgs.map((o): FicheOrganisation => {
    const id = (t: string) => o.identifiants.find((i) => i.type === t)?.valeur ?? null;
    const identites = o.companies.map((c) => c.legalIdentity).filter((x) => x != null);
    const estDuGroupe = o.roles.some((r) => r.role === "SOCIETE_DU_GROUPE");
    const fiche: FicheOrganisation = {
      ref: o.id,
      nom: o.raisonSociale,
      nif: id("NIF") ?? identites[0]?.nif ?? o.companyContacts.find((c) => c.nif)?.nif,
      rc: id("RC") ?? identites[0]?.rcNumber ?? o.companyContacts.find((c) => c.rc)?.rc,
      nis: id("NIS") ?? identites[0]?.nis,
      ai: id("AI") ?? identites[0]?.taxArticle,
      wilaya: [...o.companyContacts, ...o.medicalInstitutions].map((x) => x.wilaya ?? x.city).find(Boolean)
        ?? o.suppliers.map((s) => s.city).find(Boolean) ?? null,
      emails: [...identites.map((i) => i.email), ...o.companyContacts.map((c) => c.email), ...o.suppliers.map((s) => s.contactEmail), ...o.medicalInstitutions.map((i) => i.email)],
      telephones: [...identites.map((i) => i.phone), ...o.companyContacts.flatMap((c) => [c.phone, c.phoneAlt]), ...o.suppliers.map((s) => s.phone), ...o.medicalInstitutions.map((i) => i.phone)],
      estDuGroupe,
    };
    if (estDuGroupe) {
      if (fiche.nif) groupe.nifs.push(fiche.nif);
      if (fiche.rc) groupe.rcs.push(fiche.rc);
      if (fiche.nis) groupe.nis.push(fiche.nis);
    }
    return fiche;
  });
  return { fiches, groupe };
}

/** Les propositions du moment, dans un ordre stable (niveau, score, paire) : le curseur d'un lot est un rang. */
export async function calculerPropositions(): Promise<PropositionDoublon[]> {
  const { fiches, groupe } = await fichesOrganisations();
  return proposerDoublonsOrganisations(fiches, groupe).propositions;
}

const cleDePaire = (p: { a: string; b: string }) => (p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`);

/** À BLANC : combien de paires seraient proposées pour la première fois. */
export async function apercuDesDoublons(): Promise<BilanReprise> {
  const [propositions, connues] = await Promise.all([
    calculerPropositions(),
    prisma.propositionDoublonOrganisation.findMany({ select: { organisationAId: true, organisationBId: true } }),
  ]);
  const deja = new Set(connues.map((c) => `${c.organisationAId}|${c.organisationBId}`));
  const bilan = bilanVide();
  bilan.lues = propositions.length;
  for (const p of propositions) {
    if (deja.has(cleDePaire(p))) bilan.ignorees++;
    else bilan.doublonsProposes++;
  }
  return bilan;
}

/** UN LOT : les propositions de rang `apresId` (exclu) à `apresId + taille`, enregistrées. */
export async function enregistrerDoublons(opts: { taille: number; apresId?: string | null }): Promise<BilanReprise & { suite: string | null }> {
  const debut = opts.apresId ? Number(opts.apresId) : 0;
  if (!Number.isInteger(debut) || debut < 0) throw new Error(`Curseur de reprise inconnu : « ${opts.apresId} ».`);
  const propositions = await calculerPropositions();
  const lot = propositions.slice(debut, debut + Math.max(1, Math.floor(opts.taille)));
  const bilan = bilanVide();
  for (const p of lot) {
    bilan.lues++;
    try {
      if (await prisma.$transaction((tx) => proposerDoublon(tx, p.a, p.b, p))) bilan.doublonsProposes++;
      else bilan.ignorees++;
    } catch (e) {
      noterErreur(bilan, `${p.a} / ${p.b} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const fin = debut + lot.length;
  return { ...bilan, suite: fin < propositions.length ? String(fin) : null };
}
