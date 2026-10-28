import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireModule } from "@/lib/session";
import { getMyWorkspace } from "@/lib/queries/hr";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ongletsEspace } from "@/lib/queries/mes-taches";
import { trierConges } from "@/lib/queries/mes-decisions";
import { chargerAujourdhui } from "@/lib/queries/aujourdhui-espace";
import { cn } from "@/lib/utils";
import { listMyReminders } from "@/lib/queries/reminders";
import { MyReminders } from "@/components/reminders/my-reminders";
import { LeaveApprovals } from "@/components/hr/leave-approvals";
import { discussionsDesConges } from "@/lib/queries/conges-discussion";
import { MyAdvances, type AdvanceItem } from "./my-advances";
import { MyPortfolioCard } from "@/components/planning/my-portfolio-card";
import { getMyPortfolio } from "@/lib/queries/portfolio";
import { TrainingRequestButton } from "@/components/purchase/training-request-button";
import { ExpenseClaimButton } from "@/components/hr/expense-claim-button";
import { getManagerOfUser } from "@/lib/departments";
import { ANCRE_MES_AVANCES } from "@/lib/chemins/rh";
import type { Fragment, Semaine, Tuile } from "@/lib/espace/aujourdhui";
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
  const [reminders, manager] = await Promise.all([
    listMyReminders(user.id),
    // Le responsable hiérarchique — nommé dans le formulaire de formation : il ne se choisit pas.
    getManagerOfUser(user.id).catch(sansBloquer("mon-espace-page.MonEspacePage.getManagerOfUser", null)),
  ]);
  const reminderRows = reminders.map((r) => ({ ...r, remindAt: r.remindAt.toISOString(), sentAt: r.sentAt ? r.sentAt.toISOString() : null }));

  const jour = await chargerAujourdhui(user, {
    maintenant,
    nom: user.name,
    employeeId: data.employee?.id ?? null,
    tachesOuvertes: data.stats.openTasks,
    tachesRetard: data.stats.overdue,
    rappels: reminders.filter((r) => r.status === "PENDING").length,
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {jour.metiers.map((m) => (
            <span key={m} className="rounded-md border border-border bg-secondary px-1.5 py-0.5 text-xs font-medium">{m}</span>
          ))}
          <span className="inline-block text-xs first-letter:uppercase">{dateDuJour}{semaineLabel ? ` · ${semaineLabel}` : ""}</span>
        </div>
      </header>
      <ModuleTabs tabs={onglets} />

      {/* VOTRE JOURNÉE — une phrase calculée sur la file, et les chiffres du métier. */}
      <section aria-labelledby="journee-titre" className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <p id="journee-titre" className="text-[11px] font-bold uppercase tracking-wider text-primary">Votre journée</p>
        <p className="max-w-[80ch] text-[15px] leading-relaxed sm:text-base"><Phrase fragments={jour.phrase} /></p>
        <Tuiles tuiles={jour.tuiles} />
      </section>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <FileAFaire lots={jour.lots} />

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
          <Panneau titre="Ma semaine" aside="dim. → jeu.">
            <MaSemaine s={jour.semaine} />
          </Panneau>

          {jour.equipe && jour.equipe.directs > 0 && (
            <Panneau titre="Mon équipe" aside={`${jour.equipe.directs} direct${jour.equipe.directs > 1 ? "s" : ""}`}>
              <EquipeEncart membres={jour.equipe.membres} personnesEnRetard={jour.equipe.personnesEnRetard} retards={jour.equipe.retards} />
            </Panneau>
          )}

          <Panneau titre="Mes rappels" aside={reminderRows.length > 0 ? `${reminderRows.length} actif${reminderRows.length > 1 ? "s" : ""}` : undefined}>
            <div className="space-y-3">
              <MyReminders reminders={reminderRows} />
              <RappelRapide />
            </div>
          </Panneau>

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
              <LigneMoi titre="Congé" detail={data.stats.leaveBalance !== null ? `Solde ${data.stats.leaveBalance} j` : "Depuis votre dossier RH"}>
                <Link href="/mon-dossier" className="inline-flex h-9 items-center rounded-[var(--radius)] border border-border bg-card px-3 text-xs font-medium hover:bg-secondary sm:h-8">Demander</Link>
              </LigneMoi>
              <LigneMoi titre="Formation" detail={manager?.fullName ? `Validée par ${manager.fullName}` : "Validée par votre responsable"}>
                <TrainingRequestButton managerName={manager?.fullName ?? null} compact />
              </LigneMoi>
              <LigneMoi titre="Attestation de travail" detail="Depuis votre dossier RH">
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
        <div key={t.cle} className={cn("grid min-w-0 content-start gap-0.5 rounded-xl border px-3 py-2.5", TON_TUILE[t.ton].carte)}>
          <span className="text-xs font-semibold text-muted-foreground">{t.k}</span>
          <span className={cn("break-words text-xl font-bold leading-tight tabular-nums sm:text-[22px]", TON_TUILE[t.ton].valeur)}>{t.v}</span>
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

function MaSemaine({ s }: { s: Semaine }) {
  const max = Math.max(4, ...s.barres.map((b) => b.n));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4">
        <div
          className="grid h-[72px] w-[72px] place-items-center rounded-full"
          style={{ background: `conic-gradient(hsl(var(--success)) ${s.pct}%, hsl(var(--secondary)) 0)` }}
          role="img"
          aria-label={`${s.fait} faits, ${s.reste} restants`}
        >
          <div className="grid h-[56px] w-[56px] place-items-center rounded-full bg-card text-center leading-none">
            <b className="text-base tabular-nums">{s.pct}%</b>
            <span className="text-[10px] text-muted-foreground">fait</span>
          </div>
        </div>
        <div className="grid h-[72px] grid-cols-5 items-end gap-1.5" aria-label="Gestes par jour">
          {s.barres.map((b) => (
            <div key={b.jour} className="grid h-full grid-rows-[1fr_auto] gap-1 text-center">
              <div className="relative flex items-end justify-center">
                {b.etat === "futur" ? (
                  <div className="h-[18px] w-full rounded border border-dashed border-border" />
                ) : (
                  <div
                    className={cn("w-full rounded-t-[5px] rounded-b-[2px]", b.etat === "aujourdhui" ? "bg-success" : "bg-success/50")}
                    style={{ height: `${Math.max(3, Math.round((b.n / max) * 48))}px` }}
                    title={`${b.n} geste${b.n > 1 ? "s" : ""}`}
                  />
                )}
              </div>
              <span className={cn("text-[11px]", b.etat === "aujourdhui" ? "font-bold text-foreground" : "text-muted-foreground")}>
                {b.label}{b.etat !== "futur" ? <span className="block tabular-nums">{b.n}</span> : <span className="block">&nbsp;</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Fait n={s.fait} label="faits cette semaine" />
        <Fait n={s.reste} label="restent dans la file" />
        <Fait n={s.mois} label="gestes ce mois-ci" />
      </div>
      {s.reconnaissance && (
        <p className="rounded-lg bg-success/10 px-3 py-2 text-[13px]"><Phrase fragments={s.reconnaissance} /></p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Un geste = une décision datée (validation, achat, congé, étape Ad &amp; Pro), un paiement réglé, une déclaration validée, une tâche terminée.
      </p>
    </div>
  );
}

function Fait({ n, label }: { n: number; label: string }) {
  return (
    <div className="grid min-w-0 gap-0.5 rounded-lg bg-secondary px-2.5 py-2">
      <b className="text-base tabular-nums">{n}</b>
      <span className="break-words text-[11px] text-muted-foreground">{label}</span>
    </div>
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
