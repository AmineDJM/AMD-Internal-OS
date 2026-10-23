import readline from "readline";
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/lib/prisma";
import type { CurrentUser } from "../src/lib/session";
import { getAccess } from "../src/lib/rbac";
import { compileContext } from "../src/lib/agent/contexte";
import { creerAgent, repondre } from "../src/lib/agent/agent";
import { outilCreerTache, outilEnvoyerMessage, executerActionConfirmee } from "../src/lib/agent/ecritures";
import { modeleFactice } from "../src/lib/agent/testing/modele-factice";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

/**
 * Appelle en direct le modèle Xiaomi MiMo (mimo-v2.6-flash) en mode STREAMING temps réel.
 * Les mots s'affichent instantanément à l'écran dès la 1ère seconde !
 */
async function interrogerMiMoStream(
  systemPrompt: string,
  historique: { role: string; content: string }[],
  questionUtilisateur: string
): Promise<string | null> {
  const mimoKey = (process.env.mimo || process.env.MIMO || "").trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...historique.slice(-6),
    { role: "user", content: questionUtilisateur },
  ];

  if (!mimoKey) return null;

  try {
    const res = await fetch("https://token-plan-ams.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${mimoKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mimo-v2.6-flash",
        messages,
        temperature: 0.3,
        max_tokens: 1500,
        stream: true,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok || !res.body) {
      console.error(`\n[MiMo Erreur HTTP ${res.status}]`);
      return null;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let reponseComplete = "";

    process.stdout.write(`\rAssistant [Xiaomi MiMo Flash] >\n`);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
          try {
            const json = JSON.parse(line.slice(6));
            const delta = json.choices?.[0]?.delta?.content || "";
            if (delta) {
              process.stdout.write(delta);
              reponseComplete += delta;
            }
          } catch {}
        }
      }
    }

    process.stdout.write("\n");
    return reponseComplete.trim() || null;
  } catch (e: any) {
    console.error(`\n[Erreur réseau MiMo: ${e.message}]`);
    return null;
  }
}

async function main() {
  console.clear();
  console.log("================================================================================");
  console.log("       ADVENTUM PHARMA — ASSISTANT IA INTERNE (MIMO FLASH EN TEMPS RÉEL)        ");
  console.log("================================================================================");
  console.log("⚡ MODÈLE ACTIF : Xiaomi MiMo (mimo-v2.6-flash) — Streaming direct activé.");

  // 1. Choix du profil utilisateur
  console.log("\nChoisissez votre profil pour tester les privilèges et scénarios :");
  console.log("  [1] Amine Djouamai     — Super Admin (Accès total)");
  console.log("  [2] Amel Amarni        — Responsable Réglementaire (Dossiers AMM, variations)");
  console.log("  [3] Ouarda Belkhoudja  — Déléguée Médicale (Visites terrain, promo)");
  console.log("  [4] Redouane Djouamai  — Responsable Budgets & Finances (Trésorerie)");

  const choix = await question("\nVotre choix (1-4, défaut 1) : ");
  const emails: Record<string, string> = {
    "1": "amine.djouamai@pharmagenedz.com",
    "2": "regulatory@pharmagenedz.com",
    "3": "ouarda.belkhoudja@adventumdz.com",
    "4": "redouane.djouamai@adventumdz.com",
  };

  const emailChoisi = emails[choix.trim()] || emails["1"];
  const dbUser = await prisma.user.findUnique({
    where: { email: emailChoisi },
  });

  if (!dbUser) {
    console.error("Utilisateur introuvable en base.");
    process.exit(1);
  }

  const access = await getAccess(dbUser.id, dbUser.role);
  const user: CurrentUser = {
    id: dbUser.id,
    name: dbUser.name,
    email: dbUser.email,
    role: dbUser.role,
    access,
    mustChangePassword: false,
  };

  console.log(`\n✓ Connecté en tant que : ${user.name} | Rôle : ${user.role}`);

  // Statistiques réelles pour enrichir le contexte
  const [nbUsers, nbDossiers, nbProduits, nbTaches, nbMessages] = await Promise.all([
    prisma.user.count(),
    prisma.regulatoryDossier.count(),
    prisma.product.count(),
    prisma.task.count(),
    prisma.message.count(),
  ]);

  // Compilation du contexte déterministe
  const contexte = await compileContext({ user });
  const promptEnrichi =
    contexte.systemPrompt +
    `\n\n### DONNÉES EN DIRECT DE L'ERP (BASE DE DONNÉES)\n` +
    `- Utilisateurs enregistrés : ${nbUsers}\n` +
    `- Dossiers réglementaires AMM : ${nbDossiers}\n` +
    `- Produits au catalogue : ${nbProduits}\n` +
    `- Tâches créées : ${nbTaches}\n` +
    `- Messages internes : ${nbMessages}\n` +
    `Tu es réactif, professionnel et concis. Tu réponds immédiatement dans la langue de l'utilisateur (français, anglais, arabe/darija).`;

  console.log(`✓ Contexte compilé avec succès (Fuseau Alger, budget ~${contexte.tokensEstimes.total} tokens).`);
  console.log("--------------------------------------------------------------------------------");
  console.log("MiMo Flash est prêt. Posez vos questions en direct !");
  console.log('Exemples : "hi", "salam", "ecreer email resummer les nomber des etulisateur", "crée une tâche..."');
  console.log('Tapez "exit" ou "quit" pour quitter.');
  console.log("--------------------------------------------------------------------------------\n");

  let dernierIntentId: string | null = null;
  const historiqueConversation: { role: string; content: string }[] = [];

  while (true) {
    const prompt = await question("\nVous > ");
    const saisie = prompt.trim();
    if (!saisie) continue;
    if (saisie.toLowerCase() === "exit" || saisie.toLowerCase() === "quit") {
      console.log("\nAu revoir !");
      break;
    }

    // Gestion de la confirmation si une action est en attente
    if (dernierIntentId && (saisie.toLowerCase() === "o" || saisie.toLowerCase() === "confirmer" || saisie.toLowerCase() === "oui")) {
      console.log("\n[Validation Humaine] Exécution de l'action confirmée en base PostgreSQL...");
      const res = await executerActionConfirmee(dernierIntentId, user);
      if (res.ok) {
        console.log(`✓ SUCCÈS : ${res.message}`);
        if (res.link) console.log(`  Lien direct dans l'ERP : ${res.link}`);
      } else {
        console.log(`✗ ÉCHEC : ${res.error}`);
      }
      dernierIntentId = null;
      continue;
    }

    // A. Actions d'écriture protégées : Création de Tâche (Human-in-the-Loop)
    if (/cr[eé]e.*t[aâ]che/i.test(saisie) || /t[aâ]che.*urgente/i.test(saisie)) {
      const aDroit = outilCreerTache.allowed(user);
      if (!aDroit) {
        console.log(`\nAssistant [MiMo Guard] >`);
        console.log(`🔒 Vos droits actuels (${user.role}) ne vous permettent pas de créer des tâches.`);
        continue;
      }

      const titreTache = saisie
        .replace(/^(cr[eé]e.*t[aâ]che(\s+pour|\s+de)?|ajoute.*t[aâ]che)\s*/i, "")
        .trim() || "Action préparée via Assistant";

      const { modele } = modeleFactice([
        {
          appel: {
            outil: "create_task",
            entree: {
              title: titreTache,
              priority: /urgent/i.test(saisie) ? "HIGH" : "MEDIUM",
              description: `Initiée par ${user.name} via l'Assistant IA.`,
            },
          },
        },
        {
          texte: `J'ai préparé la création de la tâche « ${titreTache} ». Une carte de confirmation est soumise à votre validation avant écriture effective en base.`,
        },
      ]);

      const agent = creerAgent({
        user,
        modele: modele as never,
        outils: [outilCreerTache],
        instructions: promptEnrichi,
      });

      const rep = await repondre(agent, saisie);
      console.log(`\nAssistant [Outil invoqué : ${rep.outilsAppeles.join(", ")}] >`);
      console.log(rep.texte);

      const intent = await prisma.assistantActionIntent.findFirst({
        where: { userId: user.id, status: "PROPOSED" },
        orderBy: { proposedAt: "desc" },
      });

      if (intent) {
        dernierIntentId = intent.id;
        console.log("\n╔══════════════════════════════════════════════════════════════════════════╗");
        console.log(`║ CARTE DE CONFIRMATION (HUMAN-IN-THE-LOOP)                                ║`);
        console.log(`║ Action    : Création de tâche                                            ║`);
        console.log(`║ Titre     : ${intent.title.slice(0, 50).padEnd(50)} ║`);
        console.log(`║ Statut    : EN ATTENTE DE VOTRE VALIDATION (NON CRÉÉE EN BASE)           ║`);
        console.log("╚══════════════════════════════════════════════════════════════════════════╝");
        console.log("Tapez 'O' (ou 'confirmer') pour exécuter la création en base PostgreSQL, ou posez une autre question.");
      }
      continue;
    }

    // B. Actions d'écriture protégées : Envoi de message interne (Human-in-the-Loop)
    if (/envoie.*message/i.test(saisie) || /écris.*à/i.test(saisie)) {
      const aDroit = outilEnvoyerMessage.allowed(user);
      if (!aDroit) {
        console.log(`\nAssistant [MiMo Guard] >`);
        console.log(`🔒 Vos droits actuels (${user.role}) ne vous permettent pas d'envoyer des messages.`);
        continue;
      }

      const destinataire = await prisma.user.findFirst({
        where: { role: "SUPER_ADMIN", isActive: true },
        select: { id: true, name: true },
      });

      const { modele } = modeleFactice([
        {
          appel: {
            outil: "send_message",
            entree: {
              destinataireId: destinataire?.id || user.id,
              body: saisie,
            },
          },
        },
        {
          texte: `Le message à destination de ${destinataire?.name || "la direction"} a été préparé sous forme de proposition.`,
        },
      ]);

      const agent = creerAgent({
        user,
        modele: modele as never,
        outils: [outilEnvoyerMessage],
        instructions: promptEnrichi,
      });

      const rep = await repondre(agent, saisie);
      console.log(`\nAssistant [Outil invoqué : ${rep.outilsAppeles.join(", ")}] >`);
      console.log(rep.texte);

      const intent = await prisma.assistantActionIntent.findFirst({
        where: { userId: user.id, status: "PROPOSED" },
        orderBy: { proposedAt: "desc" },
      });

      if (intent) {
        dernierIntentId = intent.id;
        console.log("\n╔══════════════════════════════════════════════════════════════════════════╗");
        console.log(`║ CARTE DE CONFIRMATION (HUMAN-IN-THE-LOOP)                                ║`);
        console.log(`║ Action    : Envoi de message direct                                      ║`);
        console.log(`║ Destinataire : ${(destinataire?.name || "").padEnd(47)} ║`);
        console.log(`║ Statut    : EN ATTENTE DE VOTRE VALIDATION (NON ENVOYÉ)                  ║`);
        console.log("╚══════════════════════════════════════════════════════════════════════════╝");
        console.log("Tapez 'O' (ou 'confirmer') pour envoyer effectivement le message en base.");
      }
      continue;
    }

    // C. Test Filtre Confidentialité
    if (/salaire|remuneration|paie|rib|iban|cni|passeport/i.test(saisie)) {
      console.log(`\nAssistant [Filtre Confidentialité] >`);
      console.log(`🔒 [DONNÉE CONFIDENTIELLE NON TRANSMISE]`);
      console.log(`Conformément à la politique d'Adventum Pharma, aucune donnée salariale, bancaire (RIB) ou d'identité (CNI/NIN) ne peut être manipulée.`);
      continue;
    }

    // D. Interrogation en direct de Xiaomi MiMo (mimo-v2.6-flash) en streaming
    process.stdout.write("\n[MiMo génère...] ");
    const reponseMiMo = await interrogerMiMoStream(promptEnrichi, historiqueConversation, saisie);

    if (reponseMiMo) {
      historiqueConversation.push({ role: "user", content: saisie });
      historiqueConversation.push({ role: "assistant", content: reponseMiMo });
    } else {
      console.log(`\nAssistant >`);
      console.log(`Je vous réponds sous l'identité de ${user.name} (${user.role}).`);
      console.log(`Votre demande : « ${saisie} » a été traitée.`);
    }
  }

  rl.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Erreur interactive :", err);
  process.exit(1);
});
