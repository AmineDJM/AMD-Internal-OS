/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES DES NEUF TABLES DE PERSONNES, PRÊTES POUR LE MOTEUR DE DOUBLONS (`referentiels/doublons.ts`).
 *
 * Un seul chargeur pour l'inventaire en lecture seule (`scripts/refonte/inventaire-doublons.ts`) et pour la
 * reprise qui PROPOSE les doublons entre Personnes (`reprise-doublons.ts`) : les deux comparent les mêmes
 * fiches, sinon l'inventaire mesurerait autre chose que ce que la reprise propose.
 *
 * Le NIN d'un salarié est lu pour être COMPARÉ (« même NIN » rapproche, deux NIN différents séparent) ; il
 * ne sort jamais d'ici : les raisons du moteur disent « même NIN », jamais la valeur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FichePersonne } from "@/lib/referentiels/doublons";
import { nomComplet } from "@/lib/referentiels/normalisation";
import type { Db } from "@/lib/referentiels/personnes/rattachement";

export interface FicheChargee {
  fiche: FichePersonne;
  personneId: string | null;
}

export async function chargerFichesPersonnes(db: Db): Promise<FicheChargee[]> {
  const [docteurs, beneficiaires, voyageurs, hebergements, employes, users, annuaire, candidats, portail] = await Promise.all([
    db.medicalDoctor.findMany({ select: { id: true, personneId: true, name: true, firstName: true, lastName: true, phone: true, email: true, wilaya: true, city: true, institution: true, institutionId: true } }),
    db.careBeneficiary.findMany({ select: { id: true, personneId: true, firstName: true, lastName: true, institution: true, doctorId: true } }),
    db.adProVoyageur.findMany({ select: { id: true, personneId: true, nom: true, prenom: true } }),
    db.adProHebergement.findMany({ select: { id: true, personneId: true, nom: true, prenom: true } }),
    db.employee.findMany({ select: { id: true, personneId: true, fullName: true, email: true, phone: true, birthDate: true, nationalId: true, userId: true } }),
    db.user.findMany({ where: { isSystem: false }, select: { id: true, personneId: true, name: true, email: true, phone: true } }),
    db.directoryEntry.findMany({ where: { contactId: null }, select: { id: true, personneId: true, displayName: true, userId: true, employeeId: true, endpoints: { select: { channel: true, value: true } } } }),
    db.recruitmentCandidate.findMany({ select: { id: true, personneId: true, fullName: true, email: true, phone: true, employeeId: true } }),
    db.supplierUser.findMany({ select: { id: true, personneId: true, name: true, email: true } }),
  ]);
  const liens = (...refs: (string | false | null | undefined)[]) => refs.filter((x): x is string => !!x);

  return [
    ...docteurs.map((d) => ({
      personneId: d.personneId,
      fiche: {
        ref: `MedicalDoctor:${d.id}`, nom: nomComplet({ complet: d.name, nom: d.lastName, prenom: d.firstName }),
        emails: [d.email], telephones: [d.phone], wilaya: d.wilaya ?? d.city, etablissement: d.institution, etablissementId: d.institutionId,
      },
    })),
    // Un bénéficiaire tiré de l'annuaire EST le médecin : l'ERP les relie déjà.
    ...beneficiaires.map((b) => ({
      personneId: b.personneId,
      fiche: {
        ref: `CareBeneficiary:${b.id}`, nom: nomComplet({ nom: b.lastName, prenom: b.firstName }), etablissement: b.institution,
        liens: liens(b.doctorId && `MedicalDoctor:${b.doctorId}`),
      },
    })),
    ...voyageurs.map((v) => ({ personneId: v.personneId, fiche: { ref: `AdProVoyageur:${v.id}`, nom: nomComplet({ nom: v.nom, prenom: v.prenom }) } })),
    ...hebergements.map((h) => ({ personneId: h.personneId, fiche: { ref: `AdProHebergement:${h.id}`, nom: nomComplet({ nom: h.nom, prenom: h.prenom }) } })),
    ...employes.map((e) => ({
      personneId: e.personneId,
      fiche: {
        ref: `Employee:${e.id}`, nom: e.fullName, emails: [e.email], telephones: [e.phone], naissance: e.birthDate, nin: e.nationalId,
        liens: liens(e.userId && `User:${e.userId}`),
      },
    })),
    ...users.map((u) => ({ personneId: u.personneId, fiche: { ref: `User:${u.id}`, nom: u.name, emails: [u.email], telephones: [u.phone] } })),
    ...annuaire.map((d) => ({
      personneId: d.personneId,
      fiche: {
        ref: `DirectoryEntry:${d.id}`, nom: d.displayName,
        emails: d.endpoints.filter((x) => x.channel === "EMAIL").map((x) => x.value),
        telephones: d.endpoints.filter((x) => x.channel !== "EMAIL").map((x) => x.value),
        liens: liens(d.userId && `User:${d.userId}`, d.employeeId && `Employee:${d.employeeId}`),
      },
    })),
    ...candidats.map((c) => ({
      personneId: c.personneId,
      fiche: { ref: `RecruitmentCandidate:${c.id}`, nom: c.fullName, emails: [c.email], telephones: [c.phone], liens: liens(c.employeeId && `Employee:${c.employeeId}`) },
    })),
    ...portail.map((s) => ({ personneId: s.personneId, fiche: { ref: `SupplierUser:${s.id}`, nom: s.name, emails: [s.email] } })),
  ];
}
