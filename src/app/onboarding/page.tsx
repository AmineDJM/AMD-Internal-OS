import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { accessibleModules } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { NAVIGATION, ROLE_LABELS } from "@/lib/labels";
import { OnboardingWizard, type GuideEntry } from "./onboarding-wizard";

export const metadata = { title: "Bienvenue — AMD Internal OS" };

/**
 * Descriptions courtes par destination (clé = href). Rendent le « plan de votre
 * espace » concret : à quoi sert chaque onglet auquel l'utilisateur a accès.
 */
const DESTINATION_HELP: Record<string, string> = {
  "/mon-espace": "Tout ce qui vous concerne : ce qui attend votre signature, vos tâches, vos congés.",
  "/messages": "Messagerie interne temps réel — discutez par canal ou en privé, partagez des fichiers.",
  "/courrier": "Votre boîte e-mail professionnelle (Infomaniak) lue et envoyée sans quitter l'OS.",
  "/directives": "Les instructions priorisées de la Direction et l'espace d'échange associé.",
  "/mon-dossier": "Votre dossier RH : congés, documents, avances sur salaire.",
  "/regulatory": "Dossiers d'enregistrement (AMM/ANPP), échéances et documents réglementaires.",
  "/sponsoring": "Demandes de sponsoring : circuit d'analyse, budget et validation.",
  "/budgets": "Suivi budgétaire par ligne, engagements et consommation.",
  "/finances": "Trésorerie, paie, écritures et synthèse comptable (DZD).",
  "/rh": "Gestion des ressources humaines : employés, congés, demandes.",
  "/congress-international": "Demandes de congrès (national & international) jusqu'à l'ordre de dépense.",
  "/events": "Événements internes : inscriptions, QR codes et émargement.",
  // « Ventes » et « Commandes & logistique » ont été RETIRÉS du service
  // (`lib/modules-retired.ts`) : les présenter à l'arrivée promettrait des écrans qui n'existent
  // plus pour personne.
  "/pch": "Marchés PCH : appels d'offres, bons de commande et cautions.",
  "/medical/annuaire": "Annuaire : médecins et pharmaciens (hôpital / libéral), leurs coordonnées et leur segmentation.",
  "/medical/rapports": "Rapports terrain des délégués : visites rapportées, comptes rendus, pharmacovigilance.",
  "/information-medicale": "Information médicale réglementaire : déclarations et circuit documentaire.",
  "/validations": "Centre de validation transversal : ce que vous devez approuver.",
  "/drive": "Vos fichiers chiffrés, partagés en interne en toute sécurité.",
  "/demandes": "Bureau du secrétariat (attestations, notes de frais, ordres de mission…).",
  "/support": "Demandes de support (questions, brochures, documents) vers les experts.",
  "/documents": "Tous les documents générés et déposés sur la plateforme.",
  "/notifications": "Vos notifications et alertes en temps réel.",
  "/feedback": "Envoyez vos retours et suggestions à l'administrateur.",
  "/adventum-brain": "Le cockpit d'intelligence Adventum Brain (vue 360, risques, copilote).",
  "/process-intelligence": "L'analyse des processus et la synthèse IA de l'activité.",
  "/admin": "L'administration : comptes, accès ultra-granulaires, sécurité et journaux.",
};

export default async function OnboardingPage() {
  const user = await requireUser();
  if (user.mustChangePassword) redirect("/change-password");

  const modules = accessibleModules(user);
  const [dbUser, mailAccount] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { phone: true, title: true } }),
    prisma.mailAccount.findUnique({ where: { userId: user.id }, select: { id: true } }),
  ]);

  // Plan de l'espace : on reprend la même résolution que la barre latérale (un
  // onglet est visible si l'utilisateur a accès à au moins un de ses sous-onglets).
  const guide: GuideEntry[] = NAVIGATION.reduce<GuideEntry[]>((acc, n) => {
    if (n.masque) return acc; // une entrée mise de côté n'est pas une destination à présenter
    const visible = n.tabs ? n.tabs.some((t) => modules.includes(t.module)) : modules.includes(n.module);
    if (!visible) return acc;
    const href = n.tabs ? (n.tabs.find((t) => modules.includes(t.module))?.href ?? n.href) : n.href;
    acc.push({
      label: n.label,
      href,
      icon: n.icon,
      group: n.group,
      help: DESTINATION_HELP[href] ?? DESTINATION_HELP[n.href] ?? "",
    });
    return acc;
  }, []);

  return (
    <OnboardingWizard
      userName={user.name}
      roleLabel={ROLE_LABELS[user.role] ?? user.role}
      email={user.email}
      phone={dbUser?.phone ?? ""}
      title={dbUser?.title ?? ""}
      mailConnected={Boolean(mailAccount)}
      canConnectMail={modules.includes("WORKSPACE")}
      guide={guide}
    />
  );
}
