/**
 * K7 (décision 0037) POUR L'E2E AU FAUX MODÈLE — sous `tsx`, avec le code de PRODUCTION du fil et des outils.
 *
 *   demander <email> <message>   dépose le message dans SON fil, puis le JOUE au FAUX MODÈLE : le modèle appelle
 *                                `exporter_suivi_regulatory` (le vrai export, déposé au Drive), puis `send_message` avec
 *                                la pièce (son nodeId, relu dans la sortie de l'outil), puis répond avec les deux liens.
 *                                L'écran n'en sait rien que par sa relecture (`/api/assistant-ia/fil`), comme en vrai.
 *
 * Pour quand le vrai modèle n'est pas joignable (crédit épuisé) : la preuve d'ÉCRAN reste faisable — la carte, le
 * téléchargement, l'envoi — ; le passage au vrai modèle est le banc `scripts/bench/k7-exports.ts`.
 */
import { prisma } from "@/lib/prisma";
import { deposerMessage, traiterFil } from "@/modules/assistant-ia/api";
import { modeleFactice, remplacerModelesPourTests } from "@/modules/assistant-ia/api-banc";

async function main(): Promise<void> {
  const [cmd, email, message] = process.argv.slice(2);
  if (cmd !== "demander" || !email || !message) throw new Error("usage : k7-exports.ts demander <email> <message>");
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const nodeId = (prompt: string) => /\\?"nodeId\\?":\s*\\?"(c[a-z0-9]{20,})/.exec(prompt)?.[1] ?? "";
  const f = modeleFactice([
    { appel: { outil: "exporter_suivi_regulatory", entree: {} } },
    (p) => ({ appel: { outil: "send_message", entree: { recipientName: "Amel Haddad", body: "Voici le suivi Regulatory.", pieces: [nodeId(p)] } } }),
    (p) => ({ texte: JSON.stringify({ message: `Le suivi Regulatory est prêt : [ouvrir le fichier](/drive/${nodeId(p)}) · [Télécharger](/api/drive/${nodeId(p)}/raw?dl=1). Le message à Amel Haddad attend votre confirmation.`, components: [] }) }),
  ]);
  remplacerModelesPourTests([f.modele as never]);
  const d = await deposerMessage(u.id, message, []);
  if (!d.ok) throw new Error(d.erreur);
  await traiterFil(u.id);
  const reponse = await prisma.assistantIaTour.findFirst({ where: { repondA: d.tour.id }, select: { etat: true, contenu: true, erreur: true } });
  process.stdout.write(JSON.stringify({ tours: f.toursJoues(), reponse }));
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
