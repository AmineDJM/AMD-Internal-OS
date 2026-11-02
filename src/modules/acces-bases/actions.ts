"use server";

/**
 * LES GESTES DE LA CONSOLE « ACCÈS PAR BASE » (lot D2, décision 0057) — clé `acces-bases-actions`.
 * Réservés au Super Admin RÉEL (pas en Vue exacte). Chaque geste : motif obligatoire, daté, journalisé à l'audit, et
 * annulable en un geste (`actionReversible`, journal des effets). Une IA ne règle jamais les accès : classé EXCLU au
 * registre de l'assistant.
 */
import { revalidatePath } from "next/cache";
import type { UserRole } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { actionReversible } from "@/lib/effets/reversible";
import { estBase, poserReglage, reglerPropresDonnees, revoquerReglage } from "@/modules/acces-bases/api";

type Resultat = { ok: true } | { ok: false; error: string; confirmation?: true };

const CHEMIN = "/admin/access/bases";
const MODULE_AUDIT = "Accès par base";

async function superAdminReel() {
  const u = await requireUser();
  return userCan(u, "ADMIN", "UPDATE") && u.role === "SUPER_ADMIN" && !u.impersonatedBy && !u.visualise ? u : null;
}
/** « AAAA-MM-JJ » (champ date du formulaire) → minuit UTC ; autre chose → null. */
function dateDe(v: FormDataEntryValue | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? "").trim());
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  return d && d.getUTCDate() === +m![3] ? d : null; // un 31 février ne glisse pas au 3 mars
}

export async function poserReglageBase(formData: FormData): Promise<Resultat> {
  return actionReversible("acces-bases-actions:poserReglageBase", "Réglage d'accès à une base", async () => {
    const admin = await superAdminReel();
    if (!admin) return { ok: false as const, error: "Réservé au Super Admin." };
    const base = String(formData.get("base") ?? "");
    if (!estBase(base)) return { ok: false as const, error: "Base inconnue." };
    const userId = String(formData.get("userId") ?? "").trim();
    const role = String(formData.get("role") ?? "").trim();
    if (!!userId === !!role) return { ok: false as const, error: "Choisissez UNE personne ou UN rôle." };
    const du = dateDe(formData.get("du"));
    if (!du) return { ok: false as const, error: "La date de début est obligatoire (AAAA-MM-JJ)." };
    const r = await poserReglage({
      base,
      cible: userId ? { userId } : { role: role as UserRole },
      niveau: String(formData.get("niveau") ?? "") as "FERMEE",
      ecriture: formData.get("ecriture") === "oui",
      du, au: dateDe(formData.get("au")),
      motif: String(formData.get("motif") ?? ""),
      confirmeSuperAdmin: formData.get("confirmeSuperAdmin") === "oui",
    }, admin.id);
    if (!r.ok) return { ok: false as const, error: r.erreur, ...(r.confirmation ? { confirmation: true as const } : {}) };
    await recordAudit({ actorId: admin.id, action: "CREATE", module: MODULE_AUDIT, entityId: r.id, field: base, summary: r.resume });
    revalidatePath(CHEMIN);
    return { ok: true as const };
  });
}

export async function revoquerReglageBase(id: string): Promise<Resultat> {
  return actionReversible("acces-bases-actions:revoquerReglageBase", "Révocation d'un réglage d'accès à une base", async () => {
    const admin = await superAdminReel();
    if (!admin) return { ok: false as const, error: "Réservé au Super Admin." };
    if (typeof id !== "string" || !id) return { ok: false as const, error: "Réglage introuvable." };
    const r = await revoquerReglage(id, admin.id);
    if (!r.ok) return { ok: false as const, error: r.erreur };
    await recordAudit({ actorId: admin.id, action: "UPDATE", module: MODULE_AUDIT, entityId: id, field: "revoqueLe", summary: r.resume });
    revalidatePath(CHEMIN);
    return { ok: true as const };
  });
}

export async function reglerPropresDonneesBase(base: string, propres: boolean): Promise<Resultat> {
  return actionReversible("acces-bases-actions:reglerPropresDonneesBase", "Accès à ses propres données (base fermée)", async () => {
    const admin = await superAdminReel();
    if (!admin) return { ok: false as const, error: "Réservé au Super Admin." };
    if (!estBase(base) || typeof propres !== "boolean") return { ok: false as const, error: "Base inconnue." };
    const r = await reglerPropresDonnees(base, propres, admin.id);
    if (!r.ok) return { ok: false as const, error: r.erreur };
    await recordAudit({ actorId: admin.id, action: "UPDATE", module: MODULE_AUDIT, entityId: base, field: "propresDonnees", newValue: String(propres), summary: r.resume });
    revalidatePath(CHEMIN);
    return { ok: true as const };
  });
}
