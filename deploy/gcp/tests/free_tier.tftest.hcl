# Offline tests: the Google provider is mocked, so no account or network is needed.
# Run from deploy/gcp: terraform init -backend=false && terraform test

mock_provider "google" {}

variables {
  project_id     = "mail-me-123456"
  ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest test@example"
}

run "defaults_stay_in_free_tier" {
  command = plan

  assert {
    condition     = google_compute_instance.this.machine_type == "e2-micro"
    error_message = "Machine type must be the free tier e2-micro."
  }
  assert {
    condition     = google_compute_instance.this.boot_disk[0].initialize_params[0].type == "pd-standard"
    error_message = "Disk must be standard persistent disk (balanced is billed)."
  }
  assert {
    condition     = google_compute_instance.this.boot_disk[0].initialize_params[0].size == 30
    error_message = "Default disk must be 30 GB."
  }
  assert {
    condition     = google_compute_instance.this.zone == "us-central1-a"
    error_message = "Default zone must be us-central1-a."
  }
  assert {
    condition     = google_compute_instance.this.boot_disk[0].initialize_params[0].image == "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
    error_message = "Image must be the Ubuntu 24.04 family."
  }
  assert {
    condition     = google_compute_instance.this.scheduling[0].preemptible == false
    error_message = "The free tier covers non-preemptible instances."
  }
}

run "zone_defaults_per_region" {
  command = plan
  variables { region = "us-east1" }

  assert {
    condition     = google_compute_instance.this.zone == "us-east1-b"
    error_message = "us-east1 must default to us-east1-b (it has no zone a)."
  }
}

run "zone_defaults_west" {
  command = plan
  variables { region = "us-west1" }

  assert {
    condition     = google_compute_instance.this.zone == "us-west1-b"
    error_message = "us-west1 must default to us-west1-b."
  }
}

run "only_ssh_is_open" {
  command = plan
  variables { ssh_source_cidr = "198.51.100.7/32" }

  assert {
    condition     = length(google_compute_firewall.ssh.allow) == 1
    error_message = "Exactly one allow block."
  }
  assert {
    condition = alltrue([
      for a in google_compute_firewall.ssh.allow : a.protocol == "tcp" && a.ports == tolist(["22"])
    ])
    error_message = "The only allowed port must be TCP 22."
  }
  assert {
    condition     = google_compute_firewall.ssh.source_ranges == toset(["198.51.100.7/32"])
    error_message = "SSH source must be ssh_source_cidr."
  }
  assert {
    condition     = google_compute_firewall.ssh.target_tags == toset(["mail-me"]) && contains(google_compute_instance.this.tags, "mail-me")
    error_message = "The firewall must target the instance's tag."
  }
  assert {
    condition     = google_compute_network.this.auto_create_subnetworks == false
    error_message = "The network must be a dedicated custom-mode VPC."
  }
}

run "ssh_key_metadata_and_no_startup_script" {
  command = plan

  assert {
    condition     = google_compute_instance.this.metadata["ssh-keys"] == "ubuntu:ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest test@example"
    error_message = "ssh-keys must carry ubuntu:<key>."
  }
  assert {
    condition     = google_compute_instance.this.metadata["block-project-ssh-keys"] == "true"
    error_message = "Project-wide SSH keys must be blocked."
  }
  assert {
    condition     = !contains(keys(google_compute_instance.this.metadata), "startup-script")
    error_message = "No startup script: install.sh does the setup."
  }
}

run "compute_api_stays_on_after_destroy" {
  command = plan

  assert {
    condition     = google_project_service.compute.disable_on_destroy == false
    error_message = "Destroy must not turn the Compute API off."
  }
}

run "outputs" {
  command = apply

  # Mocks cannot fill attributes inside nested blocks, so the output is checked against the
  # value the mock generates for nat_ip.

  assert {
    condition     = output.install_command == "deploy/linux/install.sh ubuntu@${output.public_ip}"
    error_message = "install_command must target the server."
  }
  assert {
    condition     = output.push_config_command == "deploy/linux/push-config.sh ubuntu@${output.public_ip}"
    error_message = "push_config_command must target the server."
  }
}

run "rejects_non_free_region" {
  command = plan
  variables { region = "asia-southeast1" }
  expect_failures = [var.region]
}

run "rejects_too_big_disk" {
  command = plan
  variables { disk_size_gb = 31 }
  expect_failures = [var.disk_size_gb]
}

run "rejects_too_small_disk" {
  command = plan
  variables { disk_size_gb = 9 }
  expect_failures = [var.disk_size_gb]
}

run "rejects_zone_outside_region" {
  command = plan
  variables {
    region = "us-west1"
    zone   = "us-central1-a"
  }
  expect_failures = [google_compute_instance.this]
}

run "rejects_bad_project_id" {
  command = plan
  variables { project_id = "My Project" }
  expect_failures = [var.project_id]
}
