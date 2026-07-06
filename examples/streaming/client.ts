import { connect, TcpTransport } from "@nullstyle/capnp";
import {
  CounterSink,
  createCounterSinkAddStreamSender,
} from "./gen/schema_types.ts";

using counter = await connect(
  CounterSink,
  await TcpTransport.connect("127.0.0.1", 4010),
);

const sender = createCounterSinkAddStreamSender(counter, {
  maxInFlight: 4,
});

for (const value of [3, 5, 8, 13, 21]) {
  await sender.send(value);
}
await sender.flush();

const total = await counter.total();
console.log(`streamed ${total.count} values with sum ${total.sum}`);
