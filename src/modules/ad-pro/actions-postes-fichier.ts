"use server";

import { requireUser } from "@/lib/session";
import { fdStr } from "@/lib/actions/types";
import { persistUploadedDocument } from "@/lib/documents";
import {
  PARENTS, isParent, canEditItems, demandeVisible, refusPostesClos, refusAvantPrevalidation, revalidate,
} from "./infra/postes/commun";
import { proposerPostesDuFichier } from "./infra/postes-fichier-ia";
import { nomDuCahier, phraseDeLaProposition, type PosteDuFichier } from "./domaine/postes-fichier";
import { PARENT_ENTITE, type AdProParent } from "./domaine/postes";
import { cibleDuJournalIa } from "./domaine/postes-luna";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CRÉER LES POSTES DEPUIS UN FICHIER — l'action de l'écran (recette 24/11/2026). Elle GARDE le fichier sur
 * la demande et fait PROPOSER les postes par l'IA ; elle ne crée AUCUN poste. Les lignes relues se créent
 * ensuite, une à une, par l'action ordinaire `addAdProItem` — ses gardes, son audit, ses notifications.
 *
 * LA PORTE EST CELLE DE « AJOUTER UN POSTE », dans le même ordre (`addAdProItem`) : qui ne peut pas ajouter de
 * poste à cette demande n'a rien à se faire proposer, et ne dépose rien. Une demande hors de sa portée est
 * « introuvable » — la même phrase que l'absence.
 *
 * Ce qui s'écrit : le fichier, parmi les pièces de la demande (« Cahier des charges — … », pièce complémentaire,
 * INTERNE), et le journal d'usage de l'IA. Rien d'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type PostesDuFichier =
  | { ok: true; postes: PosteDuFichier[]; remarques: string[]; phrase: string }
  /** `fichierGarde` : le fichier est sur la demande malgré le refus — l'écran propose alors la saisie à la main. */
  | { ok: false; error: string; fichierGarde: boolean };

/** La nature de la demande, dite au modèle pour le contexte. */
const NATURE_DEMANDE: Record<AdProParent, string> = {
  SPONSORING: "sponsoring",
  CONGRESS_NATIONAL: "congrès national",
  CONGRESS_INTERNATIONAL: "congrès international",
  EVENT: "événement",
  AD_PRO_OTHER: "autre demande Ad & Pro",
};

export async function proposerPostesDepuisFichier(formData: FormData): Promise<PostesDuFichier> {
  const user = await requireUser();
  const refuse = (error: string): PostesDuFichier => ({ ok: false, error, fichierGarde: false });

  // LA PORTE D'AJOUT D'UN POSTE — celle de `addAdProItem`, mêmes refus, même ordre.
  const parent = fdStr(formData, "parent") ?? "";
  if (!isParent(parent)) return refuse("Opération inconnue.");
  const parentId = fdStr(formData, "parentId");
  if (!parentId) return refuse("Opération inconnue.");
  if (!canEditItems(user, parent)) return refuse("Non autorisé.");
  const info = await PARENTS[parent].load(parentId);
  // Hors de la portée de la personne, la demande est introuvable — la même phrase que l'absence.
  if (!info || !(await demandeVisible(user, parent, parentId))) return refuse("Opération introuvable.");
  const clos = refusPostesClos(info);
  if (clos) return refuse(clos);
  const avant = refusAvantPrevalidation(info);
  if (avant) return refuse(avant);
  // UN POSTE TARDIF EST PERMIS (recette 24/11/2026) : une demande déclarée à l'information médicale prend encore des postes.

  const fichier = formData.get("fichier");
  if (!(fichier instanceof File) || fichier.size === 0) return refuse("Choisissez le fichier à lire (le cahier des charges).");
  const octets = Buffer.from(await fichier.arrayBuffer());
  const nom = nomDuCahier(fichier.name);

  const r = await proposerPostesDuFichier({
    octets, nomFichier: fichier.name, userId: user.id, natureDemande: NATURE_DEMANDE[parent], cible: cibleDuJournalIa(parent, parentId),
    // LE FICHIER RESTE SUR LA DEMANDE, sous un nom qui dit ce qu'il est : une pièce complémentaire de la demande
    // (`SUPPORTING_DOC`, comme les annexes jointes à la création), interne. Déposé après les portes, avant la lecture.
    garder: async () => {
      const d = await persistUploadedDocument(user.id, {
        entityType: PARENT_ENTITE[parent], entityId: parentId, category: "SUPPORTING_DOC", confidentiality: "INTERNAL", stepKey: null,
        file: new File([new Uint8Array(octets)], nom, { type: fichier.type || "application/octet-stream" }), buffer: octets,
      });
      if (!d.ok) return { ok: false, error: d.error ?? "Le fichier n'a pas pu être enregistré sur la demande : rien n'a été lu." };
      revalidate(parent, parentId);
      return { ok: true };
    },
  });

  if (!r.ok) {
    return { ok: false, error: r.garde ? `${r.error} Le fichier est gardé dans les pièces de la demande.` : r.error, fichierGarde: r.garde };
  }
  return {
    ok: true,
    postes: r.postes,
    remarques: r.remarques,
    phrase: phraseDeLaProposition({ nombre: r.postes.length, nomDocument: nom, coupe: r.coupe, scan: r.scan }),
  };
}
