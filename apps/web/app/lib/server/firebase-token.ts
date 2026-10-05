import { createRemoteJWKSet, jwtVerify } from "jose";

export type FirebaseIdentity = {
  uid: string;
  email: string;
  emailVerified: boolean;
  authTime: number;
};

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyFirebaseIdToken(token: string): Promise<FirebaseIdentity> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is not configured");

  let keySet = keySets.get(projectId);
  if (!keySet) {
    keySet = createRemoteJWKSet(
      new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
    );
    keySets.set(projectId, keySet);
  }

  const { payload } = await jwtVerify(token, keySet, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
    clockTolerance: 5,
    maxTokenAge: "1h",
  });

  if (
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    typeof payload.email !== "string" ||
    typeof payload.auth_time !== "number"
  ) {
    throw new Error("Firebase token is missing required claims");
  }

  return {
    uid: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    authTime: payload.auth_time,
  };
}
