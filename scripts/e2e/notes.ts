/**
 * « MES NOTES » POUR L'E2E (décision 0026) — sous `tsx`, avec le code de PRODUCTION du fil et des outils.
 *
 *   vider    <email>                         efface les notes et le fil de la personne (décor propre) ;
 *   demander <email> <message> <outil> <json>  dépose le message dans SON fil, puis le JOUE au FAUX MODÈLE : le modèle
 *                                            appelle l'outil donné avec l'entrée donnée, puis répond. L'écran n'en sait
 *                                            rien que par sa relecture (`/api/assistant-ia/fil`, `etatMesNotes`), comme
 *                                            en vrai.
 *
 * Aucun appel de modèle réel : c'est la règle de la suite E2E (le faux modèle sert aux tests seulement).
 */

import { prisma } from "@/lib/prisma";
import { deposerMessage, traiterFil } from "@/modules/assistant-ia/api";
import { modeleFactice, remplacerModelesPourTests } from "@/modules/assistant-ia/api-banc";

async function main(): Promise<void> {
  const [cmd, email, message, outil, json] = process.argv.slice(2);
  if (!email) throw new Error("usage : notes.ts vider|demander <email> …");
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  if (cmd === "vider") {
    await prisma.assistantIaNoteProposition.deleteMany({ where: { userId: u.id } });
    await prisma.assistantIaNoteVersion.deleteMany({ where: { userId: u.id } });
    await prisma.assistantIaNoteCorbeille.deleteMany({ where: { userId: u.id } });
    await prisma.assistantIaNotePage.deleteMany({ where: { userId: u.id } });
    await prisma.assistantIaFil.deleteMany({ where: { userId: u.id } });
    process.stdout.write("{}");
  } else if (cmd === "demander") {
    const f = modeleFactice([
      { appel: { outil: outil!, entree: JSON.parse(json!) as Record<string, unknown> } },
      { texte: JSON.stringify({ message: "Je vous propose cette modification dans vos notes : acceptez-la ou refusez-la dans le panneau.", components: [] }) },
    ]);
    remplacerModelesPourTests([f.modele as never]);
    const d = await deposerMessage(u.id, message!, []);
    if (!d.ok) throw new Error(d.erreur);
    await traiterFil(u.id);
    const propositions = await prisma.assistantIaNoteProposition.findMany({ where: { userId: u.id, etat: "PROPOSEE" }, select: { id: true, resume: true } });
    // Ce que le tour a répondu (le diagnostic, si la proposition manque).
    const reponse = await prisma.assistantIaTour.findFirst({ where: { repondA: d.tour.id }, select: { etat: true, contenu: true, erreur: true } });
    const sortieOutil = JSON.stringify(f.promptsRecus[1] ?? "").match(/tool-result.{0,600}/)?.[0];
    process.stdout.write(JSON.stringify({ propositions, tours: f.toursJoues(), reponse: { ...reponse, sortieOutil } }));
  } else {
    throw new Error(`commande inconnue : ${cmd}`);
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
