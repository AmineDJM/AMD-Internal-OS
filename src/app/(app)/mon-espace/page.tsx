import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireModule } from "@/lib/session";
import { getMyWorkspace, discussionsDesConges } from "@/modules/rh/api";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ongletsEspace } from "@/lib/queries/mes-taches";
import { trierConges } from "@/lib/queries/mes-decisions";
import { chargerAujourdhui } from "@/lib/queries/aujourdhui-espace";
import { cn } from "@/lib/utils";
import { listerMesRappels } from "@/lib/queries/reminders";
import { classerRappels, rappelsActifs } from "@/lib/rappels/vue";
import { MyReminders } from "@/components/reminders/my-reminders";
import { LeaveApprovals } from "@/components/hr/leave-approvals";
import { MyAdvances, type AdvanceItem } from "./my-advances";
import { MyPortfolioCard } from "@/components/planning/my-portfolio-card";
import { getMyPortfolio } from "@/lib/queries/portfolio";
import { TrainingRequestButton } from "@/components/purchase/training-request-button";
import { ExpenseClaimButton } from "@/components/hr/expense-claim-button";
import { getManagerOfUser } from "@/lib/departments";
import { ANCRE_MES_AVANCES } from "@/lib/chemins/rh";
import type { Fragment, Tuile } from "@/lib/espace/aujourdhui";
import { FileAFaire } from "./file-a-faire";
import { RappelRapide } from "./rappel-rapide";
import { EquipeEncart } from "./equipe-encart";
import { sansBloquer } from "@/lib/journal";

/**
 * « AUJOURD'HUI » — L'ONGLET PRINCIPAL DE L'ESPACE (Direction, 14/10/2026 : « Je valide l'onglet
 * Aujourd'hui qui va remplacer l'onglet Mon espace »).
 *
 * Même adresse (`/mon-espace` : liens, notifications et l'ancre `#conges-a-signer` y pointent), nouvelle
 * composition — celle du MÉTIER de la personne, lue sur ses rôles réels (`espace/aujourdhui.ts`) :
 * « Votre journée » (une phrase, 3 à 4 chiffres du métier), « À faire maintenant » groupé par lot et trié
 * par urgence, « Ma semaine », « Mon équipe » pour un N+1, les rappels, les raccourcis du métier et un
 * bloc « Moi » discret qui remplace les deux gros boutons de l'en-tête. Les autres onglets ne changent pas.
 *
 * Tout vient des lectures existantes, déjà gardées par les droits (`getActionCenter` et consorts —
 * `queries/aujourdhui-espace.ts`) : aucune donnée simulée, aucun chiffre sans source.
 */
export default async function MonEspacePage() {
  const user = await requireModule("WORKSPACE");
  const maintenant = new Date();
  const data = await getMyWorkspace(user.id);
  const [rappels, manager] = await Promise.all([
    // TOUS LES RAPPELS (recette du 23/11/2026) : les siens, ceux de l'assistant, les échéances et relances reçues.
    listerMesRappels(user.id),
    // Le responsable hiérarchique — nommé dans le formulaire de formation : il ne se choisit pas.
    getManagerOfUser(user.id).catch(sansBloquer("mon-espace-page.MonEspacePage.getManagerOfUser", null)),
  ]);
  const rappelsActifsN = rappelsActifs(classerRappels(rappels, maintenant.getTime()));

  const jour = await chargerAujourdhui(user, {
    maintenant,
    nom: user.name,
    employeeId: data.employee?.id ?? null,
    tachesOuvertes: data.stats.openTasks,
    tachesRetard: data.stats.overdue,
    rappels: rappelsActifsN,
  });
  // LES CONGÉS À SIGNER gardent leur bloc (la fiche, les boutons, le fil) : le lot « Congés à signer »
  // de la file y mène (`#conges-a-signer`), et les notifications aussi.
  const congesASigner = trierConges(jour.conges);
  const [discussionsConges, tabs, portfolio] = await Promise.all([
    discussionsDesConges(congesASigner.map((c) => c.id)),
    ongletsEspace(user),
    getMyPortfolio(user.id),
  ]);
  const onglets = tabs.map((t) => (t.href === "/mon-espace" && jour.ouverts > 0 ? { ...t, compte: jour.ouverts, tonCompte: jour.enRetard > 0 ? ("warning" as const) : undefined } : t));
  const myAdvances: AdvanceItem[] = data.myAdvances.map((a) => ({
    id: a.id, amount: Number(a.amount), reason: a.reason, status: a.status, createdAt: a.createdAt.toISOString(),
  }));

  const fmt = (o: Intl.DateTimeFormatOptions, d: Date) => new Intl.DateTimeFormat("fr-FR", { ...o, timeZone: "Africa/Algiers" }).format(d);
  const dateDuJour = fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" }, maintenant);
  const premier = jour.semaine.barres[0];
  const dernier = jour.semaine.barres[jour.semaine.barres.length - 1];
  const numero = (j: string) => String(Number(j.slice(8, 10)));
  const semaineLabel = premier && dernier ? `semaine du ${premier.label} ${numero(premier.jour)} au ${dernier.label} ${numero(dernier.jour)}` : null;
  const congesEnCours = data.stats.pendingLeaves;

  return (
    <div className="space-y-5">
      <header className="min-w-0 space-y-1">
        <h1 className="break-words text-xl font-semibold tracking-tight sm:text-2xl">Bonjour {user.name.split(" ")[0]} 👋</h1>
        <p className="text-xs text-muted-foreground first-letter:uppercase">{dateDuJour}{semaineLabel ? ` · ${semaineLabel}` : ""}</p>
        {/* VOTRE JOURNÉE EN UNE PHRASE (Direction, 16/11/2026 — « plus minimaliste ») : sous le bonjour, sans cadre. */}
        <p className="max-w-[80ch] pt-1 text-sm leading-relaxed text-muted-foreground"><Phrase fragments={jour.phrase} /></p>
      </header>
      <ModuleTabs tabs={onglets} />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {/* CE QUI M'ATTEND D'ABORD : chaque ligne mène droit au geste. Les chiffres du métier viennent après. */}
          <FileAFaire lots={jour.lots} />
          <Tuiles tuiles={jour.tuiles} />

          {congesASigner.length > 0 && (
            <section id="conges-a-signer" className="scroll-mt-20 space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Congés qui attendent votre signature ({congesASigner.length})
              </h2>
              <p className="text-xs text-muted-foreground">
                Circuit <strong>responsable (N+1) → ressources humaines → direction générale</strong>.
                Approuver fait monter d&apos;une marche ; refuser arrête le circuit.
              </p>
              <LeaveApprovals
                leaves={congesASigner.map((c) => ({ ...c, commentaires: discussionsConges[c.id] ?? [] }))}
                maintenant={maintenant.toISOString()} currentUserId={user.id}
              />
            </section>
          )}

          {jour.piecesEnAttente > 0 && (
            <p className="text-xs text-muted-foreground">
              Vous attendez {jour.piecesEnAttente} pièce{jour.piecesEnAttente > 1 ? "s" : ""} de la part d&apos;autres personnes —{" "}
              <Link href="/pieces" className="text-primary hover:underline">voir les pièces demandées</Link>.
            </p>
          )}

          {/* Ce que je porte ce cycle (« Prévisions & Force de vente ») — rien quand rien n'est affecté. */}
          <MyPortfolioCard portfolio={portfolio} />

          {myAdvances.length > 0 && (
            <section id={ANCRE_MES_AVANCES} className="scroll-mt-20 space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Mes avances sur salaire</h2>
              <MyAdvances advances={myAdvances} />
            </section>
          )}
        </div>

        <aside className="min-w-0 space-y-5">
          {/* MES RAPPELS EN TÊTE DE COLONNE (recette du 23/11/2026) : ce qu'on s'est promis de faire, à portée d'œil. */}
          <Panneau titre="Mes rappels" aside={rappelsActifsN > 0 ? `${rappelsActifsN} à traiter` : undefined}>
            <div className="space-y-3">
              <MyReminders rappels={rappels} limite={5} maintenant={maintenant.toISOString()} />
              <RappelRapide />
            </div>
          </Panneau>

          {jour.equipe && jour.equipe.directs > 0 && (
            <Panneau titre="Mon équipe" aside={`${jour.equipe.directs} direct${jour.equipe.directs > 1 ? "s" : ""}`}>
              <EquipeEncart membres={jour.equipe.membres} personnesEnRetard={jour.equipe.personnesEnRetard} retards={jour.equipe.retards} />
            </Panneau>
          )}

          {jour.raccourcis.length > 0 && (
            <Panneau titre="Raccourcis du métier">
              <div className="flex flex-wrap gap-1.5">
                {jour.raccourcis.map((r) => (
                  <Link key={r.href} href={r.href} className="inline-flex h-8 items-center rounded-md border border-border bg-card px-2.5 text-xs font-medium hover:bg-secondary">
                    {r.label}
                  </Link>
                ))}
              </div>
            </Panneau>
          )}

          {/* MOI — discret : les gestes pour soi (note de frais, congé, formation, attestation), là où ils se font. */}
          <Panneau titre="Moi" lien={{ href: "/mon-dossier", label: "Mon dossier RH" }}>
            <ul className="divide-y divide-border text-sm">
              <LigneMoi titre="Note de frais" detail="Avec le justificatif scanné">
                <ExpenseClaimButton compact />
              </LigneMoi>
              <LigneMoi titre="Formation" detail={manager?.fullName ? `Validée par ${manager.fullName}` : "Validée par votre responsable"}>
                <TrainingRequestButton managerName={manager?.fullName ?? null} compact />
              </LigneMoi>
              {/* Congé et attestation se demandent au même endroit : une ligne. */}
              <LigneMoi titre="Congé, attestation" detail={data.stats.leaveBalance !== null ? `Solde de congé : ${data.stats.leaveBalance} j` : "Depuis votre dossier RH"}>
                <Link href="/mon-dossier" className="inline-flex h-9 items-center rounded-[var(--radius)] border border-border bg-card px-3 text-xs font-medium hover:bg-secondary sm:h-8">Demander</Link>
              </LigneMoi>
              {congesEnCours > 0 && (
                <LigneMoi titre="En cours" detail={`${congesEnCours} demande${congesEnCours > 1 ? "s" : ""} de congé en instruction`} />
              )}
            </ul>
          </Panneau>
        </aside>
      </div>
    </div>
  );
}

function Phrase({ fragments }: { fragments: Fragment[] }) {
  return <>{fragments.map((f, i) => (f.b ? <b key={i} className="font-semibold">{f.t}</b> : <span key={i}>{f.t}</span>))}</>;
}

const TON_TUILE: Record<Tuile["ton"], { carte: string; valeur: string }> = {
  late: { carte: "border-transparent bg-destructive/10", valeur: "text-destructive" },
  warn: { carte: "border-transparent bg-warning/10", valeur: "text-warning" },
  ok: { carte: "border-transparent bg-success/10", valeur: "text-success" },
  "": { carte: "border-border bg-card", valeur: "" },
};

function Tuiles({ tuiles }: { tuiles: Tuile[] }) {
  if (tuiles.length === 0) return null;
  return (
    <div className={cn("grid grid-cols-2 gap-2.5", tuiles.length >= 4 ? "md:grid-cols-4" : "md:grid-cols-3")}>
      {tuiles.map((t) => (
        <div key={t.cle} className={cn("grid min-w-0 content-start gap-0.5 rounded-lg border px-3 py-2", TON_TUILE[t.ton].carte)}>
          <span className="text-xs font-semibold text-muted-foreground">{t.k}</span>
          <span className={cn("break-words text-lg font-semibold leading-tight tabular-nums", TON_TUILE[t.ton].valeur)}>{t.v}</span>
          <span className="break-words text-xs text-muted-foreground">{t.c}</span>
        </div>
      ))}
    </div>
  );
}

function Panneau({ titre, aside, lien, children }: { titre: string; aside?: string; lien?: { href: string; label: string }; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{titre}</h2>
        {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
        {lien && (
          <Link href={lien.href} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            {lien.label} <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        )}
      </div>
      <div className="min-w-0 px-4 py-3">{children}</div>
    </section>
  );
}

function LigneMoi({ titre, detail, children }: { titre: string; detail: string; children?: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="font-medium">{titre}</p>
        <p className="break-words text-xs text-muted-foreground">{detail}</p>
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </li>
  );
}
