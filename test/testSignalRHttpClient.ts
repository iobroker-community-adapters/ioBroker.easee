"use strict";

export {};

import { expect } from "chai";
import { describe, it } from "mocha";
import AxiosSignalRHttpClient from "../lib/signalr-http-client.ts";
import type { AxiosRequestConfig } from "axios";

describe("Axios SignalR HTTP client", () => {
  it("returns non-2xx responses to SignalR", async () => {
    let axiosOptions: AxiosRequestConfig | undefined;
    const httpClient = {
      request: (options: AxiosRequestConfig) => {
        axiosOptions = options;
        return Promise.resolve({
          status: 401,
          statusText: "Unauthorized",
          data: "denied",
          headers: {},
        });
      },
    };
    const client = new AxiosSignalRHttpClient(
      httpClient as unknown as ConstructorParameters<
        typeof AxiosSignalRHttpClient
      >[0],
    );
    const response = await client.send({
      method: "POST",
      url: "https://streams.easee.com/hubs/chargers/negotiate",
      content: "",
      headers: { Authorization: "Bearer test" },
      timeout: 1000,
    });
    expect(response.statusCode).to.equal(401);
    expect(response.content).to.equal("denied");
    expect(axiosOptions!.validateStatus!(500)).to.equal(true);
    expect(axiosOptions!.headers!.Authorization).to.equal("Bearer test");
  });

  it("keeps negotiation cookies for the WebSocket connection", async () => {
    const httpClient = {
      request: () =>
        Promise.resolve({
          status: 200,
          statusText: "OK",
          data: "{}",
          headers: {
            "set-cookie": ["Affinity=test; Path=/; Secure; HttpOnly"],
          },
        }),
    };
    const client = new AxiosSignalRHttpClient(
      httpClient as unknown as ConstructorParameters<
        typeof AxiosSignalRHttpClient
      >[0],
    );
    await client.send({
      method: "POST",
      url: "https://streams.easee.com/hubs/chargers/negotiate",
    });
    expect(
      client.getCookieString("https://streams.easee.com/hubs/chargers"),
    ).to.equal("Affinity=test");
  });
});
