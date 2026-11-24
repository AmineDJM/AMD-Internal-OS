"use server";

import { requireUser } from "@/lib/session";
import { clausePanelDuKam, userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { getManagerOfUser } from "@/lib/departments";
import { diagnostiquerPanelVide } from "@/lib/queries/tour-schedule";
import { reviseurDuPlan } from "@/lib/sfe/tournee";
import { MODULE_AUDIT_VISITE } from "@/lib/medical/module-visite";
import type { ActionResult } from "@/lib/actions/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « PRÉVENIR MON SUPERVISEUR » — le remède d'un panel vide, en un geste (11/2026).
 *
 * « Ma journée » disait « Aucun praticien rattaché — chez votre superviseur », et s'arrêtait là : le
 * délégué devait trouver qui, et quoi lui dire. L'écran dit désormais la VRAIE cause
 * (`diagnostiquerPanelVide`), et ce geste la porte à la bonne personne — la même cascade que la
 * validation du plan (`reviseurDuPlan`) : le superviseur de sa BU, à défaut son N+1 d'organigramme.
 *
 * La phrase envoyée est RELUE ici, jamais prise de l'écran : le superviseur lit le diagnostic du
 * serveur, pas un texte qu'un formulaire aurait pu forger. Un même jour, le même superviseur n'est
 * prévenu qu'une fois — un bouton qu'on presse trois fois ne fait pas trois notifications.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Où le superviseur répare : le territoire d'un KAM se règle dans Business Units. */
const LIEN_REMEDE = "/business-units";

export async function prevenirSuperviseurPanelVide(): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "CREATE")) {
    return { ok: false, error: "Ce geste est celui d'un délégué qui saisit ses visites : votre compte n'en saisit pas." };
  }
  // L'ÉTAT D'ABORD (§118.18) : un panel rempli entre-temps n'a plus rien à signaler.
  const unPraticien = await prisma.medicalDoctor.findFirst({ where: clausePanelDuKam(user.id), select: { id: true } });
  if (unPraticien) return { ok: false, error: "Votre panel n'est plus vide : rechargez « Ma journée »." };

  const [profil, managerRh, diagnostic] = await Promise.all([
    prisma.salesRepProfile.findUnique({ where: { repId: user.id }, select: { businessUnit: { select: { supervisorId: true } } } }),
    getManagerOfUser(user.id),
    diagnostiquerPanelVide(user.id),
  ]);
  const destinataire = reviseurDuPlan({
    repId: user.id,
    superviseurBuId: profil?.businessUnit?.supervisorId ?? null,
    managerRhId: managerRh?.userId ?? null,
  });
  if (!destinataire) {
    return {
      ok: false,
      error: "Personne à prévenir : vous n'avez ni superviseur sur votre Business Unit ni N+1 à l'organigramme. "
        + "Demandez à la Direction de désigner le superviseur de votre BU (Business Units).",
    };
  }
  const qui = await prisma.user.findUnique({ where: { id: destinataire.id }, select: { name: true } });
  const nom = qui?.name ?? "Votre superviseur";

  const minuit = new Date();
  minuit.setHours(0, 0, 0, 0);
  const titre = `Panel vide — ${user.name}`;
  const deja = await prisma.notification.findFirst({
    where: { userId: destinataire.id, type: "MEDICAL_TOUR", title: titre, createdAt: { gte: minuit } },
    select: { id: true },
  });
  if (deja) return { ok: true, message: `${nom} a déjà été prévenu(e) aujourd'hui.` };

  await notifyUser({
    userId: destinataire.id, type: "MEDICAL_TOUR", title: titre,
    body: `${user.name} ne peut ni planifier ni rapporter de visite : ${diagnostic.phrase}`,
    link: LIEN_REMEDE,
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT_VISITE,
    summary: `Panel vide signalé à ${nom} (${destinataire.source === "BU_SUPERVISEUR" ? "superviseur de la BU" : "N+1"}) — ${diagnostic.cause}`,
  });
  return { ok: true, message: `${nom} est prévenu(e) : la cause lui est envoyée avec l'écran où la corriger.` };
}
