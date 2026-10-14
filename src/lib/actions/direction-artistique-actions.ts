"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { deposerPapier, reglerModeleParType, reglerPapierParDefaut } from "@/lib/direction-artistique/serveur";
import { estTypeModele, LIBELLE_TYPE_MODELE } from "@/lib/direction-artistique/modeles";

/**
 * LES GESTES DE L'ÉCRAN « DIRECTION ARTISTIQUE » (Transverse) — déposer un modèle POUR UNE ENTITÉ,
 * désigner son papier par défaut, désigner le modèle d'une nature de pièce. Le droit, le
 * périmètre et la règle « jamais le papier d'une autre entité » sont revérifiés par
 * `lib/direction-artistique/serveur.ts` ; ici, on ne fait que lire le formulaire.
 */
const PATH = "/direction-artistique";

/** Dépose un modèle (Word, Excel, PowerPoint) — TOUJOURS rattaché à l'entité ouverte. */
export async function televerserModele(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const companyId = fdStr(formData, "companyId");
  if (!companyId) return { ok: false, error: "Choisissez l'entité à laquelle rattacher ce modèle." };
  const r = await deposerPapier(user, { kind: fdStr(formData, "kind"), file: formData.get("file"), name: fdStr(formData, "name"), companyId });
  if (!r.ok) return r;
  if (formData.get("parDefaut") === "on") {
    const d = await reglerPapierParDefaut(user, companyId, r.id ?? null);
    if (!d.ok) return { ok: false, error: `Modèle déposé, mais pas désigné par défaut : ${d.error}` };
  }
  revalidatePath(PATH);
  revalidatePath("/drive");
  return { ok: true, id: r.id, message: "Modèle déposé." };
}

/** Désigne (ou retire) le papier en-tête Word par défaut de l'entité. */
export async function definirPapierParDefaut(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const companyId = fdStr(formData, "companyId");
  if (!companyId) return { ok: false, error: "Entité manquante." };
  const r = await reglerPapierParDefaut(user, companyId, fdStr(formData, "letterheadId"));
  if (!r.ok) return r;
  revalidatePath(PATH);
  return { ok: true, message: "Papier par défaut enregistré." };
}

/** Désigne (ou retire) le modèle Word d'une nature de pièce — bon de commande, devis, facture, avoir. */
export async function definirModeleDePiece(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const companyId = fdStr(formData, "companyId");
  const type = fdStr(formData, "type");
  if (!companyId) return { ok: false, error: "Entité manquante." };
  if (!estTypeModele(type)) return { ok: false, error: "Nature de pièce inconnue." };
  const r = await reglerModeleParType(user, companyId, type, fdStr(formData, "letterheadId"));
  if (!r.ok) return r;
  revalidatePath(PATH);
  return { ok: true, message: `Modèle de ${LIBELLE_TYPE_MODELE[type].toLowerCase()} enregistré.` };
}

/** Dépose un modèle Word DÉDIÉ à une nature de pièce pour l'entité, et le désigne aussitôt. */
export async function televerserModeleDePiece(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const companyId = fdStr(formData, "companyId");
  const type = fdStr(formData, "type");
  if (!companyId) return { ok: false, error: "Entité manquante." };
  if (!estTypeModele(type)) return { ok: false, error: "Nature de pièce inconnue." };
  const depot = await deposerPapier(user, {
    kind: "word", file: formData.get("file"),
    name: fdStr(formData, "name") || `Modèle ${LIBELLE_TYPE_MODELE[type].toLowerCase()}`, companyId,
  });
  if (!depot.ok) return depot;
  const r = await reglerModeleParType(user, companyId, type, depot.id ?? null);
  if (!r.ok) return { ok: false, error: `Modèle déposé, mais pas désigné : ${r.error}` };
  revalidatePath(PATH);
  revalidatePath("/drive");
  return { ok: true, id: depot.id, message: `Modèle de ${LIBELLE_TYPE_MODELE[type].toLowerCase()} déposé et désigné.` };
}
