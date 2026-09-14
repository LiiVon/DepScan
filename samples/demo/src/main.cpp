#include <string>

#include "app/application.h"
#include "util/logger.h"

int main(int argc, char** argv) {
  demo::Application app;
  const std::string args = argc > 1 ? argv[1] : "hello demo";
  demo::setVerbose(true);
  return app.start(args);
}
