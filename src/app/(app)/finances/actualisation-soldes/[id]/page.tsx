import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { companyScopedWhere } from "@/lib/company";
import { toNumber } from "@/lib/utils";
import { jourAlger, estEtatLigne, etatDemande, LIBELLE_ETAT_DEMANDE, type EtatLigne } from "@/modules/finances/partage";
import { chargerTresorerie } from "@/modules/finances/api";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { FormulaireActualisation, type LigneEcran } from "./formulaire";

export const dynamic = "force-dynamic";
export const metadata = { title: "Actualisation des soldes — AMD Internal OS" };

/**
 * L'ÉCRAN QU'OUVRE LA NOTIFICATION « Mise à jour du solde de trésorerie demandée » (Direction, 10/2026).
 *
 * Le responsable Finance y lit ce qu'on lui demande (l'entité, la note, depuis quand) et répond compte
 * par compte : le solde du nouveau relevé et sa date, ou « pas encore reçu ». Le Super Admin y relit la
 * réponse. Qui voit les Finances voit l'écran ; seul qui peut les MODIFIER saisit — la même porte que
 * « Corriger l'ancrage ». Un compte d'une entité qu'on ne voit pas rend la demande introuvable.
 */
export default async function ActualisationSoldesPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("FINANCES");
  const demande = await prisma.demandeActualisationSoldes.findUnique({
    where: { id: params.id },
    include: {
      company: { select: { name: true, shortName: true } },
      lignes: { include: { compte: { select: { id: true, name: true, bank: true, rib: true, openingBalance: true, openingDate: true } } }, orderBy: { compte: { name: "asc" } } },
    },
  });
  if (!demande) notFound();
  const visibles = new Set((await prisma.treasuryAccount.findMany({
    where: await companyScopedWhere(user.id, { id: { in: demande.lignes.map((l) => l.compteId) } }),
    select: { id: true },
  })).map((c) => c.id));
  if (demande.lignes.some((l) => !visibles.has(l.compteId))) notFound();

  const personnes = new Map((await prisma.user.findMany({
    where: { id: { in: [demande.demandeParId, ...demande.lignes.map((l) => l.traiteParId).filter((x): x is string => Boolean(x))] } },
    select: { id: true, name: true },
  })).map((u) => [u.id, u.name]));

  // Le SOLDE ACTUEL de chaque compte, par la même lecture que Banque & paiements (`chargerTresorerie`).
  const tresorerie = await chargerTresorerie(user.id, demande.companyId);
  const soldeActuel = new Map(tresorerie.comptes.map((c) => [c.id, c]));

  const lignes: LigneEcran[] = demande.lignes.map((l) => {
    const actuel = soldeActuel.get(l.compteId);
    return {
      id: l.id,
      compte: l.compte.name,
      banque: [l.compte.bank, l.compte.rib].filter(Boolean).join(" · ") || null,
      etat: (estEtatLigne(l.etat) ? l.etat : "EN_ATTENTE") as EtatLigne,
      ancrageDemande: { solde: toNumber(l.ancienSolde), jour: jourAlger(l.ancienneDate) },
      ancrageActuel: { solde: toNumber(l.compte.openingBalance), jour: jourAlger(l.compte.openingDate) },
      soldeActuel: actuel ? actuel.solde : null,
      nouveau: l.nouveauSolde !== null && l.nouvelleDate ? { solde: toNumber(l.nouveauSolde), jour: jourAlger(l.nouvelleDate) } : null,
      traitePar: l.traiteParId ? personnes.get(l.traiteParId) ?? null : null,
      traiteLe: l.traiteLe ? l.traiteLe.toISOString() : null,
    };
  });
  const etat = etatDemande(lignes.map((l) => l.etat));
  const nomEntite = demande.company ? demande.company.shortName || demande.company.name : "Sans entité";
  const peutRepondre = userCan(user, "FINANCES", "UPDATE") && !demande.termineeLe;
  const demandeLe = demande.createdAt.toLocaleString("fr-FR", { timeZone: "Africa/Algiers", dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="space-y-5">
      <Link href={`/finances/paiements-a-faire${demande.companyId ? `?entite=${demande.companyId}` : ""}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Banque &amp; paiements
      </Link>
      <PageHeader
        title={`Actualisation des soldes — ${nomEntite}`}
        description={`Demandée par ${personnes.get(demande.demandeParId) ?? "un compte supprimé"} le ${demandeLe}.`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={etat === "TERMINEE" ? "success" : etat === "PARTIELLE" ? "info" : "warning"}>{LIBELLE_ETAT_DEMANDE[etat]}</Badge>
        <span className="text-sm text-muted-foreground">{lignes.length} compte(s)</span>
      </div>
      {demande.note && (
        <p className="rounded-lg border bg-card px-4 py-3 text-sm"><span className="font-medium">Précision : </span>{demande.note}</p>
      )}
      <FormulaireActualisation demandeId={demande.id} lignes={lignes} peutRepondre={peutRepondre} aujourdhui={jourAlger(new Date())} />
    </div>
  );
}
