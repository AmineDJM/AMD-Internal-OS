import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { companyIdForNew } from "@/lib/company";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import { reposerWilayaCode } from "@/modules/lieux/api";
import { doubleEcrireOrganisation } from "@/modules/referentiels/api";
import { doubleEcrireCoffre } from "@/modules/coffre/api";
import { getBlob } from "@/lib/drive-storage";
import { lireFichierUneFois } from "@/lib/pieces-lues/lecture-fichier";
import { annuaireDeLecture } from "@/lib/pieces-lues/service";
import { FORMATS_LUS, PAGES_MAX, TAILLE_MAX_OCTETS } from "@/lib/pieces-lues/formats";
import type { IdentiteEmetteur } from "@/lib/pieces-lues/emetteur";
import type { IdentifiantsDuGroupe } from "@/lib/pieces-lues/fournisseur";
import {
  GENRE_FOURNISSEUR, decisionFournisseurAuto, identiteLocaleDuDevis, noteFicheAutomatique, type IssueFournisseurAuto,
} from "@/lib/pieces-lues/fournisseur-auto";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FOURNISSEUR D'UN DEVIS DÉPOSÉ, RECONNU OU AJOUTÉ À L'ANNUAIRE (Direction, 02/11/2026) — l'écriture.
 *
 * La règle est dans `fournisseur-auto.ts` (pure). Ici :
 *   • UN SEUL AJOUT À LA FOIS. Deux devis du même fournisseur déposés ensemble créeraient deux fiches : la décision
 *     se prend sous un verrou transactionnel (`pg_advisory_xact_lock`), sur l'annuaire relu DANS la transaction.
 *   • UN GESTE AUTOMATIQUE, PAS UN DROIT. La personne qui dépose le devis n'a pas besoin d'écrire dans l'annuaire :
 *     la fiche naît de la pièce, pas d'une saisie — rien de ce qu'elle porte ne vient d'un champ de formulaire.
 *     Elle est TRACÉE : sa note dit le devis, la date et le déposant ; le journal d'audit l'inscrit.
 *   • LE DEVIS EST RATTACHÉ à la fiche (reconnue, probable ou créée) s'il n'avait aucune partie — jamais à la place
 *     d'une partie choisie par une personne.
 *   • JAMAIS BLOQUANT. Un échec ici ne défait pas le dépôt : il se journalise, le devis reste déposé.
 *
 * Hors d'un fichier « use server » : l'auteur est reçu en argument (§118.153).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les portes de l'annuaire des partenaires (celles de `company-contact-actions.ts`). */
const PAGES_ANNUAIRE = ["/mon-espace/annuaire", "/annuaires/partenaires"] as const;

export async function fournisseurDuDevisDansLAnnuaire(i: {
  userId: string;
  legalDocumentId: string;
  identite: IdentiteEmetteur;
  groupe: IdentifiantsDuGroupe;
  /** Vrai quand le nom ne vient que du nom du fichier : il reconnaît une fiche, il n'en crée pas. */
  nomDuFichierSeul?: boolean;
}): Promise<IssueFournisseurAuto | null> {
  try {
    const [companyId, devis, deposant] = await Promise.all([
      companyIdForNew(i.userId),
      prisma.legalDocument.findUnique({ where: { id: i.legalDocumentId }, select: { title: true } }),
      prisma.user.findUnique({ where: { id: i.userId }, select: { name: true } }),
    ]);
    const le = new Date();

    const { issue, rib } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('annuaire:fournisseur-du-devis'))`;
      const fiches = await tx.companyContact.findMany({ select: { id: true, name: true, nif: true, rc: true } });
      const d = decisionFournisseurAuto(
        i.identite, fiches.map((f) => ({ id: f.id, nom: f.name, nif: f.nif, rc: f.rc })), i.groupe,
        { nomDuFichierSeul: i.nomDuFichierSeul },
      );
      let issue: IssueFournisseurAuto;
      if (d.geste === "RIEN") {
        issue = d.raison === "AMBIGU" ? { statut: "AMBIGU", noms: d.noms } : { statut: "SANS_NOM" };
      } else if (d.geste === "RATTACHER") {
        issue = { statut: d.certitude === "CERTAIN" ? "RECONNU" : "PROBABLE", contactId: d.contactId, nom: d.nom };
      } else {
        const cree = await tx.companyContact.create({
          data: {
            ...d.fiche, kind: GENRE_FOURNISSEUR, sphere: "PRIVE", companyId,
            notes: noteFicheAutomatique({ titreDevis: devis?.title ?? null, deposant: deposant?.name ?? null, le }),
            createdById: i.userId, updatedById: i.userId,
          },
          select: { id: true, name: true },
        });
        issue = { statut: "CREE", contactId: cree.id, nom: cree.name };
      }
      if ("contactId" in issue) {
        await tx.legalDocument.updateMany({
          where: { id: i.legalDocumentId, counterpartyIds: { isEmpty: true } },
          data: { counterpartyIds: [issue.contactId], counterparty: issue.nom },
        });
      }
      return { issue, rib: d.geste === "CREER" ? d.fiche.rib : null };
    });

    if (issue.statut === "CREE") {
      const id = issue.contactId;
      await reposerWilayaCode("CompanyContact", id).catch(sansBloquer("fournisseur-annuaire.lieux"));
      if (rib) await doubleEcrireCoffre("CompanyContact", id, { rib }, i.userId).catch(sansBloquer("fournisseur-annuaire.coffre"));
      await doubleEcrireOrganisation("COMPANY_CONTACT", id, i.userId).catch(sansBloquer("fournisseur-annuaire.organisation"));
      await recordAudit({
        actorId: i.userId, action: "CREATE", module: "Moyens généraux",
        summary: `Fournisseur « ${issue.nom} » ajouté automatiquement à l'annuaire depuis le devis${devis?.title ? ` « ${devis.title} »` : ""}`,
      }).catch(sansBloquer("fournisseur-annuaire.audit"));
      try {
        for (const p of PAGES_ANNUAIRE) revalidatePath(p);
      } catch { /* hors d'une requête (banc, tâche) : rien à rafraîchir */ }
    }
    return issue;
  } catch (e) {
    console.error("[annuaire] fournisseur du devis non traité (non bloquant)", i.legalDocumentId, e);
    return null;
  }
}

/**
 * LE DEVIS DE « NOUVEAU DOCUMENT » (Legal) — sa pièce relue pour son fournisseur, quand la personne n'a choisi aucune
 * partie. La lecture est celle que le formulaire a déjà faite (gardée par l'empreinte du fichier, `lireFichierUneFois`) ;
 * à défaut, une lecture LOCALE — jamais d'envoi au modèle ici : un devis confidentiel ne sort pas de l'ERP pour cela.
 * La pièce : le premier fichier joint, sinon le fichier du Drive référencé (porte déjà vérifiée par la création).
 */
export async function fournisseurDuDevisDepose(i: {
  userId: string; legalDocumentId: string; fichier: File | null; driveNodeId: string | null;
}): Promise<IssueFournisseurAuto | null> {
  try {
    let piece: { octets: Buffer; nom: string } | null = null;
    if (i.fichier && i.fichier.size > 0) {
      piece = { octets: Buffer.from(await i.fichier.arrayBuffer()), nom: i.fichier.name };
    } else if (i.driveNodeId) {
      const node = await prisma.driveNode.findUnique({
        where: { id: i.driveNodeId },
        select: { name: true, type: true, versions: { orderBy: { version: "desc" }, take: 1, select: { blobId: true } } },
      });
      const blobId = node?.type === "FILE" ? node.versions[0]?.blobId : null;
      const octets = blobId ? await getBlob(blobId) : null;
      if (node && octets) piece = { octets, nom: node.name };
    }
    if (!piece) return null;
    const ext = (piece.nom.split(".").pop() ?? "").toLowerCase();
    if (!(FORMATS_LUS as readonly string[]).includes(ext) || piece.octets.length === 0 || piece.octets.length > TAILLE_MAX_OCTETS) {
      return { statut: "SANS_NOM" };
    }
    const lu = await lireFichierUneFois({ octets: piece.octets, ext, cloud: false, maxPages: PAGES_MAX, userId: i.userId });
    if (!lu.ok) return { statut: "SANS_NOM" };
    const { groupe } = await annuaireDeLecture(i.userId);
    const { identite, nomDuFichierSeul } = identiteLocaleDuDevis(lu.lecture.texte, piece.nom, groupe);
    return await fournisseurDuDevisDansLAnnuaire({ userId: i.userId, legalDocumentId: i.legalDocumentId, identite, groupe, nomDuFichierSeul });
  } catch (e) {
    console.error("[annuaire] devis Legal non relu pour son fournisseur (non bloquant)", i.legalDocumentId, e);
    return null;
  }
}
