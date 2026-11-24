"use server";

import { revalidatePath } from "next/cache";
import type { EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import {
  TETES_DEFINITIVES, apercuDuPerimetre, detruireDefinitivement, fichiersDuPerimetre, libererLesFichiers, perimetreDefinitif,
  resumeDeLaDestruction, type ApercuDefinitif, type Perimetre,
} from "@/lib/suppression/definitif-serveur";
import {
  NATURES_SUPPRESSION_DEFINITIVE, REFUS_REFERENCE, estNatureSuppressionDefinitive, referenceConfirmee, referenceDeLaDemande,
  refusSuppressionDefinitive, type NatureSuppressionDefinitive,
} from "./domaine/suppression-definitive";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER DÉFINITIVEMENT UNE DEMANDE AD & PRO — le Super Admin réel, et lui seul (24/11/2026).
 *
 * ── L'UNIQUE EXCEPTION AUX INVARIANTS D'ARGENT ───────────────────────────────────────────
 * Partout ailleurs, un ordre payé ne s'efface pas (la corbeille refuse la demande qui le justifie, une
 * annulation contre-passe). Ici, le Super Admin retire la demande ET tout ce qui lui est lié : ses
 * ordres de dépense à tout statut, PAYÉS compris, leurs dossiers, l'écriture de trésorerie de chaque
 * règlement (le solde calculé change, le budget remonte — c'est voulu). Rien d'autre : un budget, un
 * médecin de l'annuaire, une pièce ou un ordre qui sert aussi autre chose restent (seul le lien part).
 * Le cliquet `lib/suppression/definitive.test.ts` vérifie que cette porte est la seule à détruire ainsi.
 *
 * Deux gestes, une seule porte (`refusSuppressionDefinitive`) : l'APERÇU (ce qui part, chiffré) et la
 * DESTRUCTION (la référence retapée, une transaction, UNE ligne d'audit qui survit — pas de corbeille).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Où la demande s'affichait — revalidé après la destruction. */
const CHEMIN: Record<NatureSuppressionDefinitive, string> = {
  SPONSORING: "/sponsoring",
  CONGRESS_NATIONAL: "/congress-national",
  CONGRESS_INTERNATIONAL: "/congress-international",
  EVENT: "/events",
  AD_PRO_OTHER: "/ad-pro/autres",
  PROMO_MATERIAL: "/promo-material",
};

export type ApercuSuppressionDefinitive =
  | { ok: true; nature: string; reference: string; titre: string; apercu: ApercuDefinitif }
  | { ok: false; error: string };

interface Ouverte { kind: NatureSuppressionDefinitive; id: string; p: Perimetre; reference: string; titre: string; userId: string }

/** LA PORTE, commune à l'aperçu et à la destruction : qui, quoi, le périmètre relu MAINTENANT. */
async function ouvrir(formData: FormData): Promise<Ouverte | { ok: false; error: string }> {
  const user = await requireUser();
  const refus = refusSuppressionDefinitive(user);
  if (refus) return { ok: false, error: refus };
  const kind = fdStr(formData, "kind") ?? "";
  const id = fdStr(formData, "id");
  if (!id || !estNatureSuppressionDefinitive(kind)) return { ok: false, error: "Demande invalide : rouvrez la fiche de la demande et recommencez." };
  const p = await perimetreDefinitif(TETES_DEFINITIVES[kind], id);
  if (!p) return { ok: false, error: "Demande introuvable (déjà supprimée ?) : rechargez la liste Ad & Pro." };
  const tete = p.inv.lignes[0]!.donnees;
  const reference = referenceDeLaDemande({ id, reference: typeof tete.reference === "string" ? tete.reference : null });
  const titre = String(tete.institution ?? tete.title ?? tete.name ?? reference);
  return { kind, id, p, reference, titre, userId: user.id };
}

/** CE QUI VA DISPARAÎTRE — lu avant de retaper la référence, dans le même périmètre que la destruction. */
export async function apercuSuppressionDefinitiveAdPro(formData: FormData): Promise<ApercuSuppressionDefinitive> {
  const o = await ouvrir(formData);
  if ("ok" in o) return o;
  return { ok: true, nature: NATURES_SUPPRESSION_DEFINITIVE[o.kind], reference: o.reference, titre: o.titre, apercu: await apercuDuPerimetre(o.p) };
}

/** DÉTRUIRE — la référence retapée, puis UNE transaction ; la trace est écrite dedans, les fichiers libérés après. */
export async function supprimerDefinitivementDemandeAdPro(formData: FormData): Promise<ActionResult> {
  const o = await ouvrir(formData);
  if ("ok" in o) return o;
  if (!referenceConfirmee(fdStr(formData, "reference"), o.reference)) return { ok: false, error: REFUS_REFERENCE };
  if (o.p.inv.bloquants.length) {
    return { ok: false, error: `Suppression impossible — rien n'a été supprimé : ${o.p.inv.bloquants.join(" ; ")}. Retirez ce lien depuis l'élément cité, puis recommencez.` };
  }
  const apercu = await apercuDuPerimetre(o.p);
  const resume = resumeDeLaDestruction({ nature: NATURES_SUPPRESSION_DEFINITIVE[o.kind], reference: o.reference, titre: o.titre }, apercu);
  const fichiers = fichiersDuPerimetre(o.p);
  try {
    await detruireDefinitivement(o.p, async (tx) => {
      await tx.auditLog.create({
        data: { actorId: o.userId, action: "DELETE", module: "Ad & Pro", entityType: o.kind as EntityType, entityId: o.id, summary: resume },
      });
    });
  } catch (err) {
    console.error("[suppression-definitive] échec", o.kind, o.id, err);
    return { ok: false, error: "Suppression impossible : rien n'a été retiré (un élément lié a changé pendant le geste). Rouvrez l'aperçu et recommencez." };
  }
  await libererLesFichiers(fichiers);
  for (const chemin of [CHEMIN[o.kind], "/ad-pro", "/mon-espace", "/finances", "/finances/paiements-a-faire", "/budget", "/budget-marketing", "/centre-de-paiement"]) {
    revalidatePath(chemin);
  }
  return { ok: true, redirect: "/ad-pro", message: `${NATURES_SUPPRESSION_DEFINITIVE[o.kind]} ${o.reference} supprimé(e) définitivement — ${apercu.lignes} élément(s) retiré(s).` };
}
