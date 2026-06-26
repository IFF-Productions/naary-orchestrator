import { SetMetadata } from "@nestjs/common";

/** Marks a route as exempt from the bearer AuthGuard (HMAC-authed webhook ingress,
 *  public OAuth redirect). */
export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
