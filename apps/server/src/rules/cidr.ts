import { Address4, Address6, AddressError } from "ip-address";

export function assertValidCidr(input: string): void {
  const cidr = input.trim();
  if (!cidr) {
    throw new Error("CIDR is required");
  }
  if (!cidr.includes("/")) {
    throw new Error("CIDR must include a prefix length (e.g. 10.0.0.0/8 or 2001:db8::/32)");
  }

  const slashIdx = cidr.lastIndexOf("/");
  const addrPart = cidr.slice(0, slashIdx);
  if (!addrPart.length || slashIdx === cidr.length - 1) {
    throw new Error("CIDR must include a numeric prefix length after '/'");
  }

  const isV6 = addrPart.includes(":");

  let addr: Address4 | Address6;
  try {
    addr = isV6 ? new Address6(cidr) : new Address4(cidr);
  } catch (e) {
    if (e instanceof AddressError) {
      const detail = e.parseMessage != null ? `: ${e.parseMessage}` : "";
      throw new Error(`Invalid CIDR${detail}`);
    }
    throw e;
  }

  if (addr.bigInt() !== addr.startAddress().bigInt()) {
    throw new Error("CIDR must use the network address; unset host bits within the prefix");
  }
}
