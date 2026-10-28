import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { peutSeConnecter } from "@/lib/missions/agent/account";
import { z } from "zod";
import { authConfig } from "./auth.config";
import { prisma } from "./lib/prisma";
import { clientIp, parseDevice } from "./lib/device";
import { enrichSessionGeo } from "./lib/geo";
import { checkLockout, recordFailure, clearAttempts } from "./lib/login-throttle";
import { sansBloquer } from "@/lib/journal";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const SESSION_TTL_DAYS = 30;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Mot de passe", type: "password" },
      },
      async authorize(credentials, request) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;
        const emailKey = email.toLowerCase();

        // Contexte requête (IP/appareil) — utile pour le throttling ET la session.
        const headers = (request as Request | undefined)?.headers;
        const ua = headers?.get("user-agent") ?? null;
        const ip = headers ? clientIp(headers) : null;
        const { device, os, browser } = parseDevice(ua);

        // Anti-bruteforce : si l'identifiant est verrouillé (trop d'échecs),
        // on refuse sans même tester le mot de passe. Message générique côté UI
        // (pas d'énumération de comptes) ; le verrouillage expire seul.
        if ((await checkLockout(emailKey)).locked) return null;

        // Recherche insensible à la casse : un compte dont l'email contient une
        // majuscule (données importées/anciennes) doit pouvoir se connecter — sinon
        // aucun changement de mot de passe ne le débloquerait.
        const user = await prisma.user.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
          orderBy: { createdAt: "asc" },
        });
        // UN COMPTE SYSTÈME NE SE CONNECTE JAMAIS — refusé AVANT toute comparaison.
        //
        // Adam, l'agent principal, existe dans l'ERP avec le rôle SUPER_ADMIN : il a des
        // missions, des livrables, un journal. Ce qu'il n'a pas, c'est une porte d'entrée. Un
        // compte auquel on peut se connecter est un compte qu'on peut PRENDRE — et le prendre
        // donnerait les pleins pouvoirs sans passer par le plan compilé, l'approbation, le reçu
        // et la double signature. Le refus est ici, en premier, et non dans une convention de
        // nommage : voir `missions/agent/account.ts`.
        if (!user || !peutSeConnecter(user)) {
          // On compte aussi les tentatives sur des comptes inexistants/inactifs/système
          // (anti credential-stuffing, anti-énumération).
          await recordFailure(emailKey, ip);
          return null;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          const r = await recordFailure(emailKey, ip);
          if (r.lockedNow) {
            await prisma.auditLog
              .create({
                data: {
                  actorId: user.id,
                  action: "LOGIN",
                  module: "Sécurité",
                  ipAddress: ip,
                  summary: `Compte verrouillé après ${r.failures} tentatives échouées : ${emailKey}`,
                },
              })
              .catch(sansBloquer("auth.authorize.auditLog"));
          }
          return null;
        }

        // Connexion réussie : on réinitialise le compteur d'échecs.
        await clearAttempts(emailKey);

        const session = await prisma.userSession.create({
          data: {
            userId: user.id,
            ipAddress: ip,
            userAgent: ua,
            device,
            os,
            browser,
            expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86400000),
          },
        });
        enrichSessionGeo(session.id, ip); // background geolocation

        await prisma.user
          .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
          .catch(sansBloquer("auth.authorize.user"));
        await prisma.activityLog
          .create({
            data: {
              userId: user.id,
              type: "LOGIN",
              ipAddress: ip,
              device,
              os,
              browser,
              userAgent: ua,
            },
          })
          .catch(sansBloquer("auth.authorize.activityLog"));
        await prisma.auditLog
          .create({
            data: {
              actorId: user.id,
              action: "LOGIN",
              module: "Authentification",
              ipAddress: ip,
              summary: `Connexion de ${user.name} (${browser} · ${os})`,
            },
          })
          .catch(sansBloquer("auth.authorize.auditLog"));

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          sid: session.id,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.role = user.role;
        token.sid = (user as { sid?: string }).sid;
        token.mustChangePassword = (user as { mustChangePassword?: boolean }).mustChangePassword ?? false;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as (typeof session.user)["role"];
        session.user.sid = token.sid as string | undefined;
        session.user.mustChangePassword = Boolean(token.mustChangePassword);
      }
      return session;
    },
  },
});
