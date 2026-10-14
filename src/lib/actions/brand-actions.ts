"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { definirLogo, definirMarque } from "@/platform/in-process/brand";

/**
 * LE REGISTRE DE MARQUE — les gestes de l'écran Administration › Marque & modèles (§26).
 *
 * Chaque geste passe par le pont, qui revérifie le droit (`canManageLetterheads`), valide champ
 * par champ et écrit l'audit au nom de la personne ; l'écran affiche mot pour mot ce que le
 * serveur a répondu — refus nommés compris. Le logo est un fichier lu ici, jamais une chaîne.
 */
const PATH = "/admin/marque";

export interface ResultatMarque extends ActionResult { refus?: string[]; champsModifies?: string[] }

/** Enregistre la charte d'une société depuis le formulaire (champs vides = inchangés ; « — » = effacer). */
export async function enregistrerMarque(_prev: ResultatMarque | undefined, formData: FormData): Promise<ResultatMarque> {
  const user = await requireUser();
  const societe = fdStr(formData, "companyId");
  if (!societe) return { ok: false, error: "Société manquante." };
  const lire = (cle: string): string | null | undefined => {
    const v = formData.get(cle);
    if (v === null) return undefined;
    const s = String(v).trim();
    if (s === "") return undefined;
    return s === "—" ? null : s;
  };
  const mentions = formData.get("mentionsLegales");
  const modification: Record<string, unknown> = {
    couleurAccent: lire("couleurAccent"), couleurSecondaire: lire("couleurSecondaire"),
    policeTitres: lire("policeTitres"), policeTexte: lire("policeTexte"),
    adresse: lire("adresse"), telephone: lire("telephone"), email: lire("email"), siteWeb: lire("siteWeb"),
    ...(mentions !== null ? { mentionsLegales: String(mentions).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) } : {}),
  };
  const sigNom = lire("signataireNom");
  if (sigNom !== undefined) modification.signataire = sigNom === null ? null : { nom: sigNom, qualite: lire("signataireQualite") ?? null };
  const parType: Record<string, unknown> = {};
  for (const type of ["DEVIS", "BON_DE_COMMANDE", "FACTURE", "LETTRE", "RAPPORT"]) {
    const nom = lire(`sig_${type}_nom`);
    if (nom === undefined) continue;
    parType[type] = nom === null ? null : { nom, qualite: lire(`sig_${type}_qualite`) ?? null };
  }
  if (Object.keys(parType).length) modification.signatairesParType = parType;
  // « Effacer » explicite : une case cochée efface la couleur ou la police correspondante.
  for (const cle of ["couleurAccent", "couleurSecondaire", "policeTitres", "policeTexte"]) if (formData.get(`effacer_${cle}`) === "on") modification[cle] = null;

  const r = await definirMarque(user, { societe, modification });
  if (!r.ok) return { ok: false, error: r.motif };
  revalidatePath(PATH);
  revalidatePath("/direction-artistique");
  const quoi = r.champsModifies.length ? `Enregistré : ${r.champsModifies.join(", ")}.` : "Rien à modifier.";
  return { ok: true, message: r.refus.length ? `${quoi} Refusé : ${r.refus.join(" ; ")}` : quoi, refus: r.refus, champsModifies: r.champsModifies };
}

/** Dépose le logo (PNG ou JPEG, 2 Mo au plus) — ou le retire si aucun fichier et « retirer » coché. */
export async function deposerLogo(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const societe = fdStr(formData, "companyId");
  if (!societe) return { ok: false, error: "Société manquante." };
  if (formData.get("retirer") === "on") {
    const r = await definirLogo(user, { societe, fichier: null });
    if (!r.ok) return { ok: false, error: r.motif };
    revalidatePath(PATH);
    revalidatePath("/direction-artistique");
    return { ok: true, message: "Logo retiré." };
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choisissez un fichier PNG ou JPEG." };
  const largeur = Number(fdStr(formData, "largeurCm") ?? "4");
  const octets = Buffer.from(await file.arrayBuffer());
  const r = await definirLogo(user, { societe, fichier: { nom: file.name, mime: file.type, octets, largeurCm: Number.isFinite(largeur) ? largeur : 4 } });
  if (!r.ok) return { ok: false, error: r.motif };
  revalidatePath(PATH);
  revalidatePath("/direction-artistique");
  return { ok: true, message: `Logo déposé : ${r.lue.marque.logo?.nom ?? file.name} (${Math.round(octets.length / 1024)} Ko, ${r.lue.marque.logo?.largeurCm ?? 4} cm de large).` };
}
