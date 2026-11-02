"use client";

import * as React from "react";
import {
  Sparkles, ArrowRight, ArrowLeft, Check, Loader2, Mail, KeyRound, ShieldCheck,
  AlertCircle, Phone, Rocket, PartyPopper, Compass, Bot, Search, FolderKanban, Wand2,
} from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { saveOnboardingProfile, completeOnboarding } from "@/lib/actions/onboarding-actions";
import { connectMailbox } from "@/lib/actions/mail-actions";
import { cn } from "@/lib/utils";
import { actionFailureMessage } from "@/lib/action-outcome";
import { AssistantPreview, SearchPreview, CourrierPreview, DossierPreview } from "./onboarding-previews";

export interface GuideEntry {
  label: string;
  href: string;
  icon: string;
  group: "Pilotage" | "Pôles" | "Transverse" | "Système";
  help: string;
}

interface Props {
  userName: string;
  roleLabel: string;
  email: string;
  phone: string;
  title: string;
  mailConnected: boolean;
  canConnectMail: boolean;
  guide: GuideEntry[];
}

type StepId = "welcome" | "profile" | "mailbox" | "tour" | "workspace" | "done";
const GROUP_ORDER: GuideEntry["group"][] = ["Pilotage", "Pôles", "Transverse", "Système"];

export function OnboardingWizard(props: Props) {
  const { userName, roleLabel, email, mailConnected, canConnectMail, guide } = props;
  const firstName = userName.split(" ")[0] || userName;

  // Étapes calculées : la boîte mail n'apparaît que si l'utilisateur y a droit
  // et ne l'a pas déjà connectée.
  const steps = React.useMemo<StepId[]>(() => {
    const s: StepId[] = ["welcome", "profile"];
    if (canConnectMail && !mailConnected) s.push("mailbox");
    s.push("tour", "workspace", "done");
    return s;
  }, [canConnectMail, mailConnected]);

  const [index, setIndex] = React.useState(0);
  const [finishing, setFinishing] = React.useState(false);
  const step = steps[index];

  const next = () => setIndex((i) => Math.min(i + 1, steps.length - 1));
  const back = () => setIndex((i) => Math.max(i - 1, 0));

  // Termine l'onboarding puis atterrit sur une destination choisie (opérationnel).
  async function finishTo(href: string) {
    setFinishing(true);
    await completeOnboarding();
    // Rechargement complet : le layout relit `mustOnboard` (désormais faux) en BDD.
    window.location.href = href;
  }
  const finish = () => finishTo(props.guide[0]?.href ?? "/mon-espace");

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-secondary/40 px-4 py-8 [padding-bottom:calc(2rem+env(safe-area-inset-bottom))]">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-2xl flex-col">
        {/* En-tête + progression */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-base font-bold text-primary-foreground">A</div>
            <span className="text-sm font-semibold tracking-tight">AMD Internal OS</span>
          </div>
          {step !== "done" && (
            <button
              onClick={finish}
              disabled={finishing}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Passer l’introduction
            </button>
          )}
        </div>

        <div className="mb-6 flex items-center gap-1.5">
          {steps.map((s, i) => (
            <div
              key={s}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                i < index ? "bg-primary" : i === index ? "bg-primary/60" : "bg-border",
              )}
            />
          ))}
        </div>

        {/* Contenu de l'étape */}
        <div className="flex-1">
          {step === "welcome" && (
            <StepShell
              icon={<Sparkles className="h-7 w-7" />}
              eyebrow="Bienvenue"
              title={`Bonjour ${firstName} 👋`}
              subtitle={`Vous êtes connecté en tant que ${roleLabel}. Quelques étapes rapides pour configurer votre espace et découvrir ce que vous pouvez faire.`}
            >
              <ul className="space-y-2.5 text-sm">
                {[
                  "Complétez vos coordonnées",
                  canConnectMail ? "Connectez votre boîte e-mail professionnelle" : null,
                  "Prenez en main les outils clés (assistant IA, recherche ⌘K…)",
                  "Découvrez les onglets auxquels vous avez accès",
                  "Démarrez par une première action concrète",
                ]
                  .filter(Boolean)
                  .map((t) => (
                    <li key={t as string} className="flex items-center gap-2.5">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-success/15 text-success">
                        <Check className="h-3.5 w-3.5" />
                      </span>
                      {t}
                    </li>
                  ))}
              </ul>
              <Footer>
                <span />
                <Button size="lg" onClick={next}>
                  Commencer <ArrowRight className="h-4 w-4" />
                </Button>
              </Footer>
            </StepShell>
          )}

          {step === "profile" && <ProfileStep {...props} onNext={next} onBack={back} />}

          {step === "mailbox" && (
            <MailboxStep email={email} displayName={userName} onNext={next} onBack={back} />
          )}

          {step === "tour" && (
            <StepShell
              icon={<Wand2 className="h-7 w-7" />}
              eyebrow="Découverte"
              title="Les outils qui vont vous faire gagner du temps"
              subtitle="Quatre réflexes à connaître. Ils sont présents partout dans l'OS — voici à quoi ils ressemblent."
            >
              <div className="space-y-5">
                <TourFeature
                  icon={<Bot className="h-4 w-4" />}
                  title="L'assistant IA, en bas à droite"
                  text="Demandez en français : « crée une tâche », « envoie un e-mail à Khaled », « résume ce dossier ». Il prépare l'action et attend toujours votre confirmation — il n'invente jamais un nom, un produit ou une date."
                  preview={<AssistantPreview />}
                />
                <TourFeature
                  icon={<Search className="h-4 w-4" />}
                  title="Tout trouver avec ⌘K"
                  text="Tapez ⌘K (ou Ctrl+K) n'importe où pour sauter à un module, un médecin, un dossier… sans cliquer dans les menus."
                  preview={<SearchPreview />}
                />
                <TourFeature
                  icon={<FolderKanban className="h-4 w-4" />}
                  title="Un sujet, tout au même endroit"
                  text="Recherche de prix, analyse IQVIA, négociation… Centralisez tout (discussion, fichiers Excel/PPT, e-mails) dans un sujet. Vous pouvez en créer un d'un clic, ou demander à l'assistant de le faire."
                  preview={<DossierPreview />}
                />
                {canConnectMail && (
                  <TourFeature
                    icon={<Mail className="h-4 w-4" />}
                    title="Votre courrier, sans quitter l'OS"
                    text="Lisez et envoyez vos e-mails professionnels depuis l'onglet Courrier. Reliez un e-mail à un dossier en un clic pour tout garder au même endroit."
                    preview={<CourrierPreview />}
                  />
                )}
              </div>
              <Footer>
                <Button variant="outline" size="lg" onClick={back}>
                  <ArrowLeft className="h-4 w-4" /> Retour
                </Button>
                <Button size="lg" onClick={next}>
                  Continuer <ArrowRight className="h-4 w-4" />
                </Button>
              </Footer>
            </StepShell>
          )}

          {step === "workspace" && (
            <StepShell
              icon={<Compass className="h-7 w-7" />}
              eyebrow="Votre espace"
              title="Voici tout ce à quoi vous avez accès"
              subtitle="Chaque pôle est cloisonné par vos droits. Vous retrouverez ces onglets dans le menu de gauche."
            >
              <div className="space-y-5">
                {GROUP_ORDER.map((group) => {
                  const items = guide.filter((g) => g.group === group);
                  if (items.length === 0) return null;
                  return (
                    <div key={group}>
                      <p className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">{group}</p>
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        {items.map((g) => (
                          <div key={g.href} className="surface flex gap-3 p-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                              <Icon name={g.icon} className="h-4 w-4" />
                            </span>
                            <div className="min-w-0">
                              <p className="text-sm font-medium leading-tight">{g.label}</p>
                              {g.help && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{g.help}</p>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <Footer>
                <Button variant="outline" size="lg" onClick={back}>
                  <ArrowLeft className="h-4 w-4" /> Retour
                </Button>
                <Button size="lg" onClick={next}>
                  Continuer <ArrowRight className="h-4 w-4" />
                </Button>
              </Footer>
            </StepShell>
          )}

          {step === "done" && (
            <StepShell
              icon={<PartyPopper className="h-7 w-7" />}
              eyebrow="C’est prêt"
              title="Votre compte est configuré"
              subtitle="Lancez-vous directement par une action concrète — ou accédez à votre espace."
            >
              {/* Démarrage opérationnel : liens directs vers les premières destinations. */}
              {props.guide.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">Commencer maintenant</p>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {props.guide.slice(0, 4).map((g) => (
                      <button
                        key={g.href}
                        onClick={() => finishTo(g.href)}
                        disabled={finishing}
                        className="surface flex items-center gap-3 p-3 text-left transition-colors hover:bg-secondary/50 disabled:opacity-60"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                          <Icon name={g.icon} className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium leading-tight">{g.label}</p>
                          {g.help && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{g.help}</p>}
                        </div>
                        <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <ShieldCheck className="h-4 w-4 text-success" /> Deux réflexes
                </p>
                <ul className="mt-1.5 space-y-1">
                  <li>Tapez <kbd className="rounded border border-border px-1.5 py-0.5 text-xs">⌘K</kbd> (ou Ctrl+K) partout pour rechercher et naviguer.</li>
                  <li>Cliquez la bulle <span className="font-medium text-foreground">assistant</span> en bas à droite pour qu'il agisse à votre place.</li>
                </ul>
              </div>
              <Footer>
                <span />
                <Button size="lg" onClick={finish} disabled={finishing}>
                  {finishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                  Accéder à mon espace
                </Button>
              </Footer>
            </StepShell>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Sous-composants ─────────────────────────── */

function StepShell({
  icon, eyebrow, title, subtitle, children,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="animate-fade-in space-y-6">
      <div className="space-y-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">{icon}</div>
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">{eyebrow}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3 pt-2">{children}</div>;
}

/** Une fonctionnalité de l'étape « Découverte » : explication + mini-maquette. */
function TourFeature({
  icon, title, text, preview,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  preview: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-2">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</span>
          {title}
        </p>
        <p className="mt-1.5 text-sm leading-snug text-muted-foreground">{text}</p>
      </div>
      {preview}
    </div>
  );
}

function ProfileStep({
  phone, title, onNext, onBack,
}: Props & { onNext: () => void; onBack: () => void }) {
  const [saving, setSaving] = React.useState(false);

  async function save(fd: FormData) {
    setSaving(true);
    await saveOnboardingProfile(fd);
    setSaving(false);
    onNext();
  }

  return (
    <StepShell
      icon={<Phone className="h-7 w-7" />}
      eyebrow="Profil"
      title="Vos coordonnées"
      subtitle="Pour que vos collègues puissent vous joindre. Vous pourrez les modifier plus tard."
    >
      <form action={save} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="title">Fonction</Label>
          <Input id="title" name="title" defaultValue={title} placeholder="ex. Déléguée médicale — Centre" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Téléphone</Label>
          <Input id="phone" name="phone" type="tel" defaultValue={phone} placeholder="ex. 0550 00 00 00" />
        </div>
        <Footer>
          <Button type="button" variant="outline" size="lg" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> Retour
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onNext}>Ignorer</Button>
            <Button type="submit" size="lg" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              Continuer
            </Button>
          </div>
        </Footer>
      </form>
    </StepShell>
  );
}

function MailboxStep({
  email, displayName, onNext, onBack,
}: {
  email: string;
  displayName: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [connected, setConnected] = React.useState(false);

  async function connect(fd: FormData) {
    setSaving(true);
    setErr(null);
    try {
      const r = await connectMailbox(fd);
      if (r.ok) {
        setConnected(true);
        setTimeout(onNext, 700);
      } else {
        setErr(r.error ?? "Connexion impossible.");
      }
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepShell
      icon={<Mail className="h-7 w-7" />}
      eyebrow="Courrier"
      title="Connectez votre boîte e-mail"
      subtitle="Lisez et envoyez vos e-mails professionnels Infomaniak sans quitter la plateforme. C’est optionnel — vous pourrez le faire depuis l’onglet Courrier à tout moment."
    >
      {connected ? (
        <div className="flex items-center gap-2 rounded-xl bg-success/10 px-4 py-3 text-sm font-medium text-success">
          <Check className="h-4 w-4" /> Boîte mail connectée. Suite…
        </div>
      ) : (
        <form action={connect} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Adresse e-mail</Label>
            <Input id="email" name="email" type="email" required defaultValue={email} placeholder="prenom.nom@adventum.dz" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Nom affiché (à l’envoi)</Label>
            <Input id="displayName" name="displayName" defaultValue={displayName} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Mot de passe d’application</Label>
            <Input id="password" name="password" type="password" required placeholder="••••••••••••" />
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              À créer dans Infomaniak : <span className="font-medium">Ma session → Mots de passe d’application</span> (n’utilisez pas votre mot de passe principal).
            </p>
          </div>

          {err && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {err}
            </div>
          )}

          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-success" /> Identifiants chiffrés (AES-256), jamais exposés.
          </p>

          <Footer>
            <Button type="button" variant="outline" size="lg" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" /> Retour
            </Button>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={onNext}>Plus tard</Button>
              <Button type="submit" size="lg" disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                Connecter
              </Button>
            </div>
          </Footer>
        </form>
      )}
    </StepShell>
  );
}
