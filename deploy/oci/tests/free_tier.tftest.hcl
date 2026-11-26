# Offline tests: the OCI provider is mocked, so no account or network is needed.
# Run from deploy/oci: terraform init -backend=false && terraform test

mock_provider "oci" {
  mock_data "oci_identity_availability_domains" {
    defaults = {
      availability_domains = [
        { name = "Xyz:EU-FRANKFURT-1-AD-1", id = "ocid1.availabilitydomain.oc1..ad1", compartment_id = "ocid1.tenancy.oc1..test" },
        { name = "Xyz:EU-FRANKFURT-1-AD-2", id = "ocid1.availabilitydomain.oc1..ad2", compartment_id = "ocid1.tenancy.oc1..test" },
      ]
    }
  }

  mock_data "oci_core_images" {
    defaults = {
      images = [{ id = "ocid1.image.oc1..ubuntu2404" }]
    }
  }

  mock_resource "oci_core_instance" {
    defaults = {
      public_ip = "203.0.113.10"
    }
  }
}

variables {
  tenancy_ocid   = "ocid1.tenancy.oc1..test"
  region         = "eu-frankfurt-1"
  ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest test@example"
}

run "defaults_stay_in_always_free" {
  command = plan

  assert {
    condition     = oci_core_instance.this.shape == "VM.Standard.A1.Flex"
    error_message = "Instance must use the Always Free Ampere A1 shape."
  }
  assert {
    condition     = oci_core_instance.this.shape_config[0].ocpus == 1 && oci_core_instance.this.shape_config[0].memory_in_gbs == 6
    error_message = "Default size must be 1 OCPU / 6 GB."
  }
  assert {
    condition     = oci_core_instance.this.source_details[0].boot_volume_size_in_gbs == "50"
    error_message = "Default boot volume must be 50 GB."
  }
  assert {
    condition     = oci_core_instance.this.source_details[0].source_id == "ocid1.image.oc1..ubuntu2404"
    error_message = "Instance must boot the looked-up Ubuntu image."
  }
  assert {
    condition     = oci_core_instance.this.availability_domain == "Xyz:EU-FRANKFURT-1-AD-1"
    error_message = "Default availability domain must be the first one."
  }
  assert {
    condition     = oci_core_instance.this.compartment_id == var.tenancy_ocid
    error_message = "Empty compartment_ocid must fall back to the tenancy."
  }
  assert {
    condition     = oci_core_instance.this.preserve_boot_volume == false
    error_message = "Teardown must remove the boot volume."
  }
}

run "only_ssh_is_open" {
  command = plan

  assert {
    condition = length([
      for r in oci_core_security_list.this.ingress_security_rules : r if r.protocol == "6"
    ]) == 1
    error_message = "There must be exactly one inbound TCP rule."
  }
  assert {
    condition = alltrue([
      for r in oci_core_security_list.this.ingress_security_rules :
      r.tcp_options[0].min == 22 && r.tcp_options[0].max == 22 if r.protocol == "6"
    ])
    error_message = "The only inbound TCP port must be 22."
  }
  assert {
    condition = alltrue([
      for r in oci_core_security_list.this.ingress_security_rules :
      contains(["1", "6"], r.protocol)
    ])
    error_message = "Inbound rules may only be SSH (TCP 22) and ICMP path-MTU."
  }
}

run "ssh_source_is_configurable" {
  command = plan

  variables {
    ssh_source_cidr = "198.51.100.7/32"
  }

  assert {
    condition = alltrue([
      for r in oci_core_security_list.this.ingress_security_rules :
      r.source == "198.51.100.7/32" if r.protocol == "6"
    ])
    error_message = "SSH rule must use ssh_source_cidr."
  }
}

run "no_user_data" {
  command = plan

  assert {
    condition     = !contains(keys(oci_core_instance.this.metadata), "user_data")
    error_message = "No user_data: install.sh does the setup over SSH."
  }
}

run "custom_size_within_limits" {
  command = plan

  variables {
    ocpus                     = 4
    memory_in_gbs             = 24
    boot_volume_size_in_gbs   = 200
    availability_domain_index = 1
  }

  assert {
    condition     = oci_core_instance.this.shape_config[0].ocpus == 4 && oci_core_instance.this.shape_config[0].memory_in_gbs == 24
    error_message = "The full Always Free size must be accepted."
  }
  assert {
    condition     = oci_core_instance.this.availability_domain == "Xyz:EU-FRANKFURT-1-AD-2"
    error_message = "availability_domain_index must pick the domain."
  }
}

run "rejects_too_many_ocpus" {
  command = plan
  variables { ocpus = 5 }
  expect_failures = [var.ocpus]
}

run "rejects_too_much_memory" {
  command = plan
  variables { memory_in_gbs = 32 }
  expect_failures = [var.memory_in_gbs]
}

run "rejects_too_big_disk" {
  command = plan
  variables { boot_volume_size_in_gbs = 250 }
  expect_failures = [var.boot_volume_size_in_gbs]
}

run "rejects_too_small_disk" {
  command = plan
  variables { boot_volume_size_in_gbs = 40 }
  expect_failures = [var.boot_volume_size_in_gbs]
}

run "rejects_missing_availability_domain" {
  command = plan
  variables { availability_domain_index = 2 }
  expect_failures = [oci_core_instance.this]
}

run "rejects_bad_ssh_key" {
  command = plan
  variables { ssh_public_key = "not-a-key" }
  expect_failures = [var.ssh_public_key]
}


run "image_override" {
  command = plan

  variables {
    image_ocid = "ocid1.image.oc1..custom"
  }

  assert {
    condition     = oci_core_instance.this.source_details[0].source_id == "ocid1.image.oc1..custom"
    error_message = "image_ocid must override the lookup."
  }
}
