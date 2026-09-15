#include "interop.capnp.h"
#include <capnp/rpc-twoparty.h>
#include <kj/async-io.h>
#include <kj/debug.h>
#include <csignal>
#include <iostream>
#include <string>
#include <unistd.h>

namespace {
struct Checks {
  uint32_t count = 0;
  uint64_t sum = 0;
  bool barrier = false;
  bool pendingCanceled = false;
};

class DoublerServer final: public Doubler::Server {
public:
  explicit DoublerServer(Checks* checks = nullptr): checks(checks) {}
private:
  Checks* checks;
  bool started = false;
  bool active = false;
  bool canceled = false;

  kj::Promise<void> fail(FailContext) override {
    return KJ_EXCEPTION(FAILED, "InteropExpectedFailure");
  }

  kj::Promise<void> compute(ComputeContext context) override {
    context.getResults().setValue(context.getParams().getValue() * 2);
    return kj::READY_NOW;
  }
  kj::Promise<void> hold(HoldContext context) override {
    KJ_REQUIRE(!started);
    started = true;
    active = true;
    auto cap = context.getParams().getCap();
    return kj::Promise<void>(kj::NEVER_DONE).attach(kj::mv(cap), kj::defer([this]() {
      active = false;
      canceled = true;
      if (checks != nullptr) checks->pendingCanceled = true;
    }));
  }
  kj::Promise<void> holdStatus(HoldStatusContext context) override {
    if (context.getParams().getRelease()) KJ_REQUIRE(canceled && !active);
    context.getResults().setStarted(started);
    context.getResults().setActive(active);
    context.getResults().setCanceled(canceled);
    return kj::READY_NOW;
  }
};

class InteropServer final: public Interop::Server {
public:
  InteropServer(kj::Timer& timer, Checks& checks): timer(timer), checks(checks) {}
private:
  kj::Timer& timer;
  Checks& checks;
  kj::Promise<void> echo(EchoContext context) override {
    context.getResults().setValue(context.getParams().getValue() + 1);
    return kj::READY_NOW;
  }
  kj::Promise<void> invoke(InvokeContext context) override {
    auto request = context.getParams().getCap().computeRequest();
    request.setValue(21);
    return request.send().then([context = kj::mv(context)](auto response) mutable {
      context.getResults().setValue(response.getValue());
    });
  }
  kj::Promise<void> child(ChildContext context) override {
    context.getResults().setCap(kj::heap<DoublerServer>(&checks));
    return kj::READY_NOW;
  }
  kj::Promise<void> fail(FailContext) override { return KJ_EXCEPTION(FAILED, "InteropExpectedFailure"); }
  kj::Promise<void> push(PushContext context) override {
    auto value = context.getParams().getValue();
    KJ_REQUIRE(value == checks.count + 1);
    // Delayed completion makes the following regular call a genuine barrier.
    return timer.afterDelay(10 * kj::MILLISECONDS).then([this, value]() {
      checks.sum += value;
      ++checks.count;
    });
  }
  kj::Promise<void> barrier(BarrierContext context) override {
    KJ_REQUIRE(checks.count == 2 && checks.sum == 3);
    checks.barrier = true;
    context.getResults().setCount(checks.count);
    context.getResults().setSum(checks.sum);
    return kj::READY_NOW;
  }
};

void consume(kj::AsyncIoContext& io, kj::StringPtr address) {
  auto remote = io.provider->getNetwork().parseAddress(address).wait(io.waitScope);
  auto stream = remote->connect().wait(io.waitScope);
  capnp::TwoPartyClient connection(*stream);
  auto client = connection.bootstrap().castAs<Interop>();
  auto echo = [&]() {
    auto request = client.echoRequest(); request.setValue(41);
    KJ_REQUIRE(request.send().wait(io.waitScope).getValue() == 42);
  };
  echo();
  {
    auto request = client.invokeRequest();
    request.setCap(kj::heap<DoublerServer>());
    KJ_REQUIRE(request.send().wait(io.waitScope).getValue() == 42);
  }
  {
    auto response = client.childRequest().send().wait(io.waitScope);
    auto child = response.getCap();
    auto request = child.computeRequest(); request.setValue(21);
    KJ_REQUIRE(request.send().wait(io.waitScope).getValue() == 42);
    bool failed = false;
    try { child.failRequest().send().wait(io.waitScope); }
    catch (const kj::Exception& e) {
      failed = e.getType() == kj::Exception::Type::FAILED && std::string(e.getDescription().cStr()).find("host call failed") != std::string::npos;
    }
    KJ_REQUIRE(failed);
    auto recovery = child.computeRequest(); recovery.setValue(21);
    KJ_REQUIRE(recovery.send().wait(io.waitScope).getValue() == 42);
    auto hold = child.holdRequest(); hold.setCap(kj::heap<DoublerServer>());
    kj::Maybe<kj::Promise<void>> pending = hold.send().ignoreResult();
    {
      auto status = child.holdStatusRequest().send().wait(io.waitScope);
      KJ_REQUIRE(status.getStarted() && status.getActive() && !status.getCanceled());
    }
    // Dropping the still-pending native RPC promise sends Finish.
    pending = nullptr;
    {
      auto request = child.holdStatusRequest(); request.setRelease(true);
      auto status = request.send().wait(io.waitScope);
      KJ_REQUIRE(status.getStarted() && !status.getActive() && status.getCanceled());
    }
    auto afterCancellation = child.computeRequest(); afterCancellation.setValue(21);
    KJ_REQUIRE(afterCancellation.send().wait(io.waitScope).getValue() == 42);
  }
  bool regularFailed = false;
  try { client.failRequest().send().wait(io.waitScope); }
  catch (const kj::Exception& e) {
    regularFailed = e.getType() == kj::Exception::Type::FAILED && std::string(e.getDescription().cStr()).find("host call failed") != std::string::npos;
  }
  KJ_REQUIRE(regularFailed);
  echo();
  auto first = client.pushRequest(); first.setValue(1);
  auto firstDone = first.send();
  auto second = client.pushRequest(); second.setValue(2);
  auto secondDone = second.send();
  auto result = client.barrierRequest().send().wait(io.waitScope);
  KJ_REQUIRE(result.getSum() == 3 && result.getCount() == 2);
  firstDone.wait(io.waitScope); secondDone.wait(io.waitScope);
}
}

int main(int argc, char** argv) {
  // A hung peer must not strand the verification job, even without its parent.
  alarm(30);
  signal(SIGPIPE, SIG_IGN);
  try {
    KJ_REQUIRE(argc >= 2);
    auto io = kj::setupAsyncIo();
    std::string mode = argv[1];
    if (mode == "server") {
      auto address = io.provider->getNetwork().parseAddress("127.0.0.1", 0).wait(io.waitScope);
      auto listener = address->listen();
      Checks checks;
      capnp::TwoPartyServer server(kj::heap<InteropServer>(io.provider->getTimer(), checks));
      std::cout << listener->getPort() << std::endl;
      auto stream = listener->accept().wait(io.waitScope);
      server.accept(*stream).wait(io.waitScope);
      KJ_REQUIRE(checks.barrier && checks.count == 2 && checks.sum == 3 && checks.pendingCanceled);
    } else {
      KJ_REQUIRE(mode == "client" && argc == 3);
      consume(io, argv[2]);
    }
    std::cerr << "native C++ " << mode << ": all checks passed\n";
    return 0;
  } catch (const kj::Exception& e) {
    std::cerr << e.getDescription().cStr() << '\n';
    return 1;
  }
}
