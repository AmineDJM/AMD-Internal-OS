/**
 * Acceptance du Run 4 — §4 RAPPELS : l'échelle de relance et son extinction, par l'outil de
 * production `plan_reminder`.
 */
import { prisma } from "@/lib/prisma";
import { pour } from "@/platform/in-process/missions/fake-reasoner";
import { recordEvent } from "@/lib/events/ledger";
import { runAssistantReminders } from "@/lib/assistant/reminders";
import { EXECUTIVE_TOOLS } from "@/lib/assistant/executive-tools";
import { type ContexteAcceptance, attendre, echelleDe } from "./banc";

export async function scenariosRappels(ctx: ContexteAcceptance): Promise<void> {
  const { TAG, PREFIXE, acteur, jouerScenario } = ctx;
  /* ═══════════════ §4 — RAPPELS : l'échelle, l'extinction, par l'OUTIL de production ═══════════════ */

  const planReminder = EXECUTIVE_TOOLS.find((t) => t.def.name === "plan_reminder");

  await jouerScenario("REM-1", "REMINDERS", "créé par l'OUTIL plan_reminder → échéance → relance +48 h → extinction d'échelle", false, async () => {
    attendre(planReminder, "l'outil plan_reminder est introuvable dans EXECUTIVE_TOOLS");
    const reponse = await planReminder.run(
      { title: `${PREFIXE} relancer le fournisseur`, quand: "dans 48h", escalations_h: [48] },
      acteur,
    );
    const rappel = await prisma.assistantReminder.findFirst({
      where: { userId: acteur.id, title: { startsWith: PREFIXE } },
      select: { id: true, dueAt: true, escalationsH: true, active: true },
      orderBy: { dueAt: "asc" },
    });
    attendre(rappel, `l'outil n'a pas créé le rappel — réponse : ${String(reponse).slice(0, 140)}`);
    const ecartH = Math.abs(rappel.dueAt.getTime() - (Date.now() + 48 * 3_600_000)) / 3_600_000;
    attendre(ecartH < 1, `le moteur temporel a mal lu « dans 48h » (écart ${ecartH.toFixed(1)} h)`);
    attendre(echelleDe(rappel.escalationsH).length === 1 && echelleDe(rappel.escalationsH)[0] === 48,
      "l'échelle de relances n'est pas enregistrée");

    // TIR nº 1 — l'échéance passe (horloge injectée) : notifié, replanifié à +48 h, barreau consommé.
    await runAssistantReminders(new Date(rappel.dueAt.getTime() + 60_000));
    let lu = await prisma.assistantReminder.findUnique({
      where: { id: rappel.id }, select: { active: true, dueAt: true, escalationsH: true },
    });
    attendre(lu?.active === true, "le rappel s'est éteint au PREMIER tir alors qu'un barreau restait");
    attendre(echelleDe(lu.escalationsH).length === 0, "le barreau de relance n'a pas été consommé");
    attendre(lu.dueAt.getTime() > rappel.dueAt.getTime() + 47 * 3_600_000, "la relance n'est pas replanifiée ~48 h plus tard");
    // TIR nº 2 — plus de barreau : le rappel se TAIT pour de bon, jamais du harcèlement.
    await runAssistantReminders(new Date(lu.dueAt.getTime() + 60_000));
    lu = await prisma.assistantReminder.findUnique({ where: { id: rappel.id }, select: { active: true, dueAt: true, escalationsH: true } });
    attendre(lu?.active === false, "l'échelle épuisée n'a pas éteint le rappel — il relancerait à l'infini");
    return {
      mesures: { occurrences: 2, echelleInitiale: [48] },
      preuve: "créé par l'outil de production (« dans 48h » lu par le moteur temporel), tiré 2 fois à horloge injectée, replanifié +48 h, puis éteint SEUL à l'épuisement de l'échelle.",
    };
  });

  await jouerScenario("REM-2", "REMINDERS", "la pièce attendue ÉTEINT le rappel et ses relances futures ; une réponse sans pièce, non", false, async () => {
    attendre(planReminder, "l'outil plan_reminder est introuvable");
    const contact = `relanceuse-${TAG}@exemple.dz`;
    await planReminder.run(
      {
        title: `${PREFIXE} contrat attendu`, quand: "dans 48h", escalations_h: [48, 72],
        stop_on_email_from: contact, stop_needs_attachment: true,
      },
      acteur,
    );
    const rappel = await prisma.assistantReminder.findFirst({
      where: { userId: acteur.id, title: `${PREFIXE} contrat attendu` },
      select: { id: true, active: true },
    });
    attendre(rappel?.active === true, "le rappel conditionnel n'a pas été créé");

    await recordEvent({
      type: "EMAIL_RECEIVED", sourceDomain: "comms",
      payload: { marqueur: TAG, from: contact, subject: `re ${TAG} : je l'envoie bientôt`, hasAttachments: false, attachments: [] },
    });
    attendre((await prisma.assistantReminder.findUnique({ where: { id: rappel.id }, select: { active: true } }))?.active === true,
      "une réponse SANS pièce a éteint un rappel qui exigeait la pièce (§26)");
    await recordEvent({
      type: "EMAIL_RECEIVED", sourceDomain: "comms",
      payload: { marqueur: TAG, from: contact, subject: `contrat ${TAG} signé`, hasAttachments: true, attachments: [`contrat-${TAG}.pdf`] },
    });
    attendre((await prisma.assistantReminder.findUnique({ where: { id: rappel.id }, select: { active: true } }))?.active === false,
      "la pièce attendue n'a pas éteint le rappel — il aurait relancé pour rien, deux fois");
    return {
      mesures: { relancesAnnulees: 2 },
      preuve: "réponse sans pièce → rappel armé ; contrat AVEC pièce → extinction immédiate, relances +48 h/+72 h annulées avec — par la 5ᵉ conséquence du registre.",
    };
  });
}
