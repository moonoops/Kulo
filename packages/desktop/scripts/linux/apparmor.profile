abi <abi/4.0>,
include <tunables/global>

profile kulo "/opt/Kulo/{Kulo,resources/runtime/node}" flags=(unconfined) {
  userns,
  include if exists <local/kulo>
}
